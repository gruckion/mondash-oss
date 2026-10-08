import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import { expandClaudeFiles, mergeClaudeContinuations, readClaudeSessions } from "./claude-archives";
import { sessionsFrom } from "./sessions";

test("native Claude archive flags follow current IDs, historical IDs and later unarchives; corrupt records do not hide sessions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "claude-archives-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, randomUUID(), randomUUID());
  await mkdir(directory, { recursive: true });
  const current = randomUUID();
  const prior = randomUUID();
  const local = `local_${randomUUID()}`;
  const file = join(directory, `${local}.json`);
  await writeFile(
    file,
    JSON.stringify({
      sessionId: local,
      cliSessionId: current,
      priorCliSessionIds: [prior],
      isArchived: true,
      lastActivityAt: 20,
    }),
  );
  await writeFile(join(directory, `local_${randomUUID()}.json`), "{incomplete");
  const wrong = `local_${randomUUID()}`;
  await writeFile(
    join(directory, `${wrong}.json`),
    JSON.stringify({ sessionId: `local_${randomUUID()}`, cliSessionId: current, isArchived: false }),
  );
  const flags = await Effect.runPromise(readClaudeSessions(root));
  assert.equal(flags.get(current)?.archived, true);
  assert.equal(flags.get(prior)?.archived, true);
  assert.equal(flags.get(local.slice(6))?.archived, true);
  assert.equal(flags.has(randomUUID()), false);
  await writeFile(
    file,
    JSON.stringify({ sessionId: local, cliSessionId: current, priorCliSessionIds: [prior], isArchived: false }),
  );
  const next = await Effect.runPromise(readClaudeSessions(root));
  assert.equal(next.get(current)?.archived, false);
  assert.equal(next.get(prior)?.archived, false);
  assert.equal((await Effect.runPromise(readClaudeSessions(join(root, "missing")))).size, 0);
});

test("Claude continuations form one conversation with the latest openable ID and earlier work evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "claude-continuations-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = join(root, "native", randomUUID(), randomUUID());
  const logs = join(root, "logs");
  await mkdir(native, { recursive: true });
  await mkdir(logs);
  const prior = randomUUID();
  const current = randomUUID();
  const unrelated = randomUUID();
  const local = `local_${randomUUID()}`;
  await writeFile(
    join(native, `${local}.json`),
    JSON.stringify({ sessionId: local, cliSessionId: current, priorCliSessionIds: [prior], isArchived: false }),
  );
  const files: string[] = [];
  for (const [id, prompt, time] of [
    [prior, "Review DEMO-1 and DEMO-2", "2026-09-25T10:00:00Z"],
    [current, "Finish DEMO-1", "2026-09-25T11:00:00Z"],
    [unrelated, "Separate DEMO-1 task", "2026-09-25T12:00:00Z"],
  ]) {
    const file = join(logs, `${id}.jsonl`);
    await writeFile(
      file,
      JSON.stringify({
        type: "user",
        message: { content: prompt },
        lastPrompt: prompt,
        cwd: "/repo",
        timestamp: time,
      }) + "\n",
    );
    files.push(file);
  }
  const sessions = await Effect.runPromise(sessionsFrom(files, Date.parse("2026-09-01T00:00:00Z")));
  const merged = await Effect.runPromise(mergeClaudeContinuations(sessions, join(root, "native")));
  assert.equal(merged.length, 2, "aliases merge, separate sessions about the same ticket stay separate");
  const conversation = merged.find((s) => s.id === current);
  assert.ok(conversation);
  assert.equal(conversation.firstPrompt, "Review DEMO-1 and DEMO-2");
  assert.equal(conversation.lastPrompt, "Finish DEMO-1");
  assert.equal(conversation.updatedAt.toISOString(), "2026-09-25T11:00:00.000Z");
  assert.equal(conversation.promptRefs["ticket:DEMO-2"], 1);
  assert.equal(conversation.archived, false);
});

test("a nominated old fragment includes the current continuation and keeps context outside the activity window", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "claude-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = join(root, "native", randomUUID(), randomUUID());
  await mkdir(native, { recursive: true });
  const prior = randomUUID(),
    current = randomUUID(),
    local = `local_${randomUUID()}`;
  await writeFile(
    join(native, `${local}.json`),
    JSON.stringify({ sessionId: local, cliSessionId: current, priorCliSessionIds: [prior], isArchived: false }),
  );
  const older = join(root, `${prior}.jsonl`),
    latest = join(root, `${current}.jsonl`);
  for (const [file, prompt, timestamp] of [
    [older, "Review DEMO-4277", "2026-08-01T10:00:00Z"],
    [latest, "Continue", "2026-09-25T10:00:00Z"],
  ])
    await writeFile(
      file,
      JSON.stringify({ type: "user", message: { content: prompt }, lastPrompt: prompt, cwd: "/repo", timestamp }) +
        "\n",
    );
  const expanded = await Effect.runPromise(expandClaudeFiles([older], [older, latest], join(root, "native")));
  assert.deepEqual(new Set(expanded), new Set([older, latest]));
  const found = await Effect.runPromise(
    sessionsFrom(expanded, Date.parse("2026-09-01T00:00:00Z"), join(root, "native")),
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].id, current);
  assert.equal(found[0].firstPrompt, "Review DEMO-4277");
  assert.equal(found[0].lastPrompt, "Continue");
  assert.equal(found[0].promptRefs["ticket:DEMO-4277"], 1);
});
