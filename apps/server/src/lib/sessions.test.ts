import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import { TestClock } from "effect/testing";
import { Store, storeKey } from "@/services/store";
import { part, sessionsFrom } from "./sessions";

const line = (prompt: string) =>
  `${JSON.stringify({ type: "user", lastPrompt: prompt, cwd: "/repo", timestamp: "2026-09-25T10:00:00Z" })}\n`;

test("a transcript is parsed once for callers at the same time, and a change is read again after a minute", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "sessions-")), "s1.jsonl");
  await writeFile(file, line("first"));

  const [a, b, soon, later] = await Effect.gen(function* () {
    const [a, b] = yield* Effect.all([part(file), part(file)], { concurrency: "unbounded" });
    yield* Effect.promise(() => appendFile(file, line("second")));
    yield* TestClock.adjust("30 seconds");
    const soon = yield* part(file);
    yield* TestClock.adjust("31 seconds");
    const later = yield* part(file);
    return [a, b, soon, later];
  }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise);

  assert.equal(a?.lastPrompt, "first");
  assert.equal(a, b);
  assert.equal(soon, a);
  assert.equal(later?.lastPrompt, "second");
});

const jsonl = (...records: unknown[]) => records.map((r) => `${JSON.stringify(r)}\n`).join("");
const codexMeta = (id: string, threadSource?: string) => ({
  type: "session_meta",
  timestamp: "2026-09-20T09:00:00Z",
  payload: { id, cwd: "/repo", ...(threadSource ? { thread_source: threadSource } : {}) },
});
const codexPrompt = (text: string, timestamp: string) => ({
  type: "response_item",
  timestamp,
  payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
});
const after = Date.parse("2026-09-01T00:00:00Z");

/** A folder whose path contains "/.codex/", which is how a file is read as a Codex transcript. */
const codexDir = async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "sessions-")), ".codex");
  await mkdir(dir);
  return dir;
};

test("injected instructions never supply session prompts or work references", async (t) => {
  const dir = await codexDir();
  t.after(() => rm(join(dir, ".."), { recursive: true, force: true }));
  const injected =
    "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nWork on DEMO-999 https://github.com/o/r/pull/999\n</INSTRUCTIONS>";
  const request = "Identify the TS compiler, then fix DEMO-12; read AGENTS.md first.";
  const timestamp = "2026-09-20T10:00:00Z";
  for (const tool of ["codex", "claude"] as const) {
    const file = join(tool === "codex" ? dir : join(dir, ".."), `${randomUUID()}.jsonl`);
    const prompt = (text: string) =>
      tool === "codex"
        ? codexPrompt(text, timestamp)
        : { type: "user", message: { content: text }, lastPrompt: text, cwd: "/repo", timestamp };
    await writeFile(
      file,
      jsonl(
        ...(tool === "codex"
          ? [
              codexMeta(randomUUID()),
              {
                ...codexPrompt("Developer instructions for DEMO-998", timestamp),
                payload: {
                  type: "message",
                  role: "developer",
                  content: [{ type: "input_text", text: "Developer instructions for DEMO-998" }],
                },
              },
              { type: "event_msg", timestamp, payload: { type: "user_message", message: injected } },
            ]
          : []),
        prompt(injected),
        prompt(request),
        prompt("<INSTRUCTIONS>Also see DEMO-997</INSTRUCTIONS>"),
        prompt(injected),
      ),
    );
    const session = await Effect.runPromise(part(file));
    assert.ok(session, tool);
    assert.equal(session.firstPrompt, request, tool);
    assert.equal(session.lastPrompt, request, tool);
    assert.deepEqual(session.refs, { "ticket:DEMO-12": 1 }, tool);
    assert.deepEqual(session.promptRefs, { "ticket:DEMO-12": 1 }, tool);
  }
});

test("a Codex session split across files is one session: first prompt from the oldest, last from the newest", async () => {
  const dir = await codexDir();
  const id = randomUUID();
  const older = join(dir, "rollout-1.jsonl");
  const newer = join(dir, "rollout-2.jsonl");
  const usage = (timestamp: string, tokens: number) => ({
    type: "event_msg",
    timestamp,
    payload: {
      type: "token_count",
      info: {
        model_context_window: 258400,
        total_token_usage: { total_tokens: 9000000 },
        last_token_usage: { total_tokens: tokens },
      },
    },
  });
  await writeFile(
    older,
    jsonl(codexMeta(id), codexPrompt("start DEMO-12", "2026-09-20T10:00:00Z"), usage("2026-09-20T10:01:00Z", 180000)),
  );
  await writeFile(
    newer,
    jsonl(codexMeta(id), codexPrompt("finish DEMO-12", "2026-09-22T10:00:00Z"), usage("2026-09-22T10:00:00Z", 40000)),
  );

  const sessions = await Effect.runPromise(sessionsFrom([newer, older], after));

  assert.equal(sessions.length, 1);
  const [session] = sessions;
  assert.equal(session.id, id);
  assert.equal(session.firstPrompt, "start DEMO-12");
  assert.equal(session.lastPrompt, "finish DEMO-12");
  assert.equal(session.updatedAt.toISOString(), "2026-09-22T10:00:00.000Z");
  assert.equal(session.promptRefs["ticket:DEMO-12"], 2);
  assert.deepEqual(
    session.contextUsage,
    { usedTokens: 40000, windowTokens: 258400 },
    "latest window usage, not lifetime usage or the largest pre-compaction value",
  );
});

test("Claude session context uses the latest main-model request, counts cache tokens and resets after compaction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sessions-context-"));
  const request = (usage: unknown, extra = {}) => ({
    type: "assistant",
    timestamp: "2026-09-20T10:00:00Z",
    message: { model: "claude-opus-5-5", usage, content: [] },
    ...extra,
  });
  const used = request({
    input_tokens: 2,
    cache_creation_input_tokens: 3000,
    cache_read_input_tokens: 45000,
    output_tokens: 500,
  });
  for (const [name, records, expected] of [
    [
      "latest",
      [
        used,
        request({ input_tokens: 3, cache_creation_input_tokens: 4000, cache_read_input_tokens: 60000 }),
        request({ input_tokens: 900000 }, { isSidechain: true }),
        {
          type: "system",
          subtype: "compact_boundary",
          timestamp: "2026-09-20T10:02:00Z",
          isSidechain: true,
          compactMetadata: { postTokens: 9000 },
        },
      ],
      { usedTokens: 64003, windowTokens: 1000000 },
    ],
    [
      "compacted",
      [
        used,
        {
          type: "attachment",
          isSidechain: true,
          attachment: { type: "model", identity: { modelId: "custom-provider[200k]" } },
        },
        {
          type: "system",
          subtype: "compact_boundary",
          timestamp: "2026-09-20T10:01:00Z",
          compactMetadata: { postTokens: 12000 },
        },
      ],
      { usedTokens: 12000, windowTokens: 1000000 },
    ],
    [
      "unknown",
      [
        request(
          { input_tokens: 5000 },
          { message: { model: "custom-provider", content: [], usage: { input_tokens: 5000 } } },
        ),
      ],
      { usedTokens: 5000 },
    ],
    ...["claude-opus-5", "claude-opus-4-8", "claude-sonnet-5-5", "claude-fable-5-1"].map(
      (model) =>
        [
          model,
          [request({}, { message: { model, content: [], usage: { input_tokens: 289000 } } })],
          { usedTokens: 289000, windowTokens: 1000000 },
        ] as const,
    ),
    [
      "explicit-small-window",
      [
        { type: "attachment", attachment: { type: "model", identity: { modelId: "claude-opus-5[200k]" } } },
        request({}, { message: { model: "claude-opus-5", content: [], usage: { input_tokens: 5000 } } }),
      ],
      { usedTokens: 5000, windowTokens: 200000 },
    ],
    ["absent", [request({ input_tokens: -1 })], undefined],
    [
      "configured",
      [
        { type: "attachment", attachment: { type: "model", identity: { modelId: "custom-provider[1m]" } } },
        request(
          { input_tokens: 5000 },
          { message: { model: "custom-provider", content: [], usage: { input_tokens: 5000 } } },
        ),
      ],
      { usedTokens: 5000, windowTokens: 1000000 },
    ],
  ] as const) {
    const file = join(dir, `${name}.jsonl`);
    await writeFile(
      file,
      jsonl({ type: "user", lastPrompt: "go", cwd: "/repo", timestamp: "2026-09-20T09:00:00Z" }, ...records),
    );
    const session = await Effect.runPromise(part(file));
    assert.ok(session);
    assert.deepEqual(session.contextUsage, expected, name);
  }
});

test("a Codex sub-agent transcript is not listed as a session", async () => {
  const dir = await codexDir();
  const file = join(dir, "rollout-sub.jsonl");
  await writeFile(file, jsonl(codexMeta(randomUUID(), "subagent"), codexPrompt("look it up", "2026-09-20T10:00:00Z")));

  assert.deepEqual(await Effect.runPromise(sessionsFrom([file], after)), []);
});

test("archived Codex transcripts remain discoverable and marked when the optional database is absent", async () => {
  const dir = join(await codexDir(), "archived_sessions");
  await mkdir(dir);
  const id = randomUUID();
  const file = join(dir, `rollout-${id}.jsonl`);
  await writeFile(file, jsonl(codexMeta(id), codexPrompt("bank verification", "2026-09-20T10:00:00Z")));
  const sessions = await Effect.runPromise(sessionsFrom([file], after));
  assert.equal(sessions[0].id, id);
  assert.equal(sessions[0].archived, true);
});

test("a session counts as active from its last message time, not its file time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sessions-"));
  const claude = (id: string, timestamp: string) => {
    const file = join(dir, `${id}.jsonl`);
    return writeFile(file, jsonl({ type: "user", lastPrompt: "go", cwd: "/repo", timestamp })).then(() => file);
  };
  const recent = await claude(randomUUID(), "2026-09-20T10:00:00Z");
  const old = await claude(randomUUID(), "2026-08-01T10:00:00Z");

  const sessions = await Effect.runPromise(sessionsFrom([recent, old], after));

  assert.deepEqual(
    sessions.map((s) => s.updatedAt.toISOString()),
    ["2026-09-20T10:00:00.000Z"],
  );
});

test("Remote Control disconnection does not establish native archive state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sessions-"));
  const archivedLine = {
    type: "system",
    subtype: "informational",
    content: "Remote Control disconnected — this session was ended or archived from another device or app (code 4090)",
    timestamp: "2026-09-25T10:05:00Z",
  };
  const prompt = { type: "user", lastPrompt: "go", cwd: "/repo", timestamp: "2026-09-25T10:00:00Z" };
  const archived = join(dir, `${randomUUID()}.jsonl`);
  await writeFile(archived, jsonl(prompt, archivedLine));
  const continued = join(dir, `${randomUUID()}.jsonl`);
  await writeFile(continued, jsonl(prompt, archivedLine, { ...prompt, timestamp: "2026-09-25T10:10:00Z" }));

  const [a, b] = await Effect.runPromise(Effect.all([part(archived), part(continued)]));
  assert.equal(a?.archived, undefined);
  assert.equal(b?.archived, undefined);
});

test("a file's saved summary is used while the file is unchanged, and saved again once it changes", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "sessions-")), `${randomUUID()}.jsonl`);
  await writeFile(file, line("on disk"));
  const { size, mtimeMs } = await stat(file);
  const saved = storeKey(`session-file:v6:${file}`, Schema.Unknown);

  const [first, second] = await Effect.gen(function* () {
    const store = yield* Store;
    const summary = { tool: "claude", id: "x", title: "saved", firstPrompt: "saved", lastPrompt: "saved" };
    yield* store.write(saved, {
      size,
      mtimeMs,
      part: { ...summary, cwd: "/repo", refs: {}, promptRefs: {}, lastAt: 0 },
    });
    const first = yield* part(file);
    yield* Effect.promise(() => appendFile(file, line("changed")));
    yield* TestClock.adjust("2 minutes");
    return [first, yield* part(file)];
  }).pipe(Effect.provide([Store.layerMemory, TestClock.layer()]), Effect.runPromise);

  assert.equal(first?.lastPrompt, "saved");
  assert.equal(second?.lastPrompt, "changed");
});

test("a Claude session is titled by its name as the Claude app shows it, then Claude's title, then the last prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sessions-"));
  const file = (name: string, records: unknown[]) => {
    const path = join(dir, `${randomUUID()}.jsonl`);
    return writeFile(path, jsonl(...records)).then(() => path);
  };
  const prompt = { type: "user", lastPrompt: "fix it", cwd: "/repo", timestamp: "2026-09-29T10:00:00Z" };
  const [named, titled, bare] = await Promise.all([
    file("named", [
      prompt,
      { type: "ai-title", aiTitle: "Fixing it" },
      { type: "custom-title", customTitle: "gritql" },
    ]),
    file("titled", [prompt, { type: "ai-title", aiTitle: "Fixing it" }]),
    file("bare", [prompt]),
  ]);
  const titles = await Effect.runPromise(
    Effect.all([part(named), part(titled), part(bare)]).pipe(Effect.provide(TestClock.layer())),
  );
  assert.deepEqual(
    titles.map((p) => p?.title),
    ["gritql", "Fixing it", "fix it"],
  );
});

test("Claude's generated continuation summary is context, not a prompt you typed", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sessions-"));
  const file = join(dir, `${randomUUID()}.jsonl`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const summary =
    "This session is being continued from a previous conversation. Work on DEMO-2561. Optional: DEMO-4277 needs a merge.";
  await writeFile(
    file,
    jsonl(
      {
        type: "user",
        isCompactSummary: true,
        message: { content: summary },
        cwd: "/repo",
        timestamp: "2026-09-29T10:00:00Z",
      },
      {
        type: "user",
        message: { content: "Continue DEMO-2561" },
        lastPrompt: "Continue DEMO-2561",
        cwd: "/repo",
        timestamp: "2026-09-29T10:01:00Z",
      },
    ),
  );
  const found = await Effect.runPromise(sessionsFrom([file], after));
  assert.equal(found[0].firstPrompt, "Continue DEMO-2561");
  assert.equal(found[0].promptRefs["ticket:DEMO-4277"], undefined);
  assert.equal(found[0].refs["ticket:DEMO-4277"], 1, "the summary remains candidate context");
  assert.equal(found[0].contextSummary, summary);
});

test("running state refreshes during the transcript summary throttle and finishes without waiting a minute", async () => {
  const dir = await codexDir();
  const id = randomUUID();
  const file = join(dir, `rollout-${id}.jsonl`);
  const event = (type: string) => ({ type: "event_msg", timestamp: "2026-09-20T10:01:00Z", payload: { type } });
  try {
    await writeFile(file, jsonl(codexMeta(id), codexPrompt("Check", "2026-09-20T10:00:00Z")));
    const states = await Effect.gen(function* () {
      const initial = yield* part(file);
      yield* Effect.promise(() => appendFile(file, jsonl(event("task_started"))));
      const started = yield* sessionsFrom([file], after);
      yield* Effect.promise(() => appendFile(file, jsonl(event("task_complete"))));
      const finished = yield* sessionsFrom([file], after);
      return [initial?.running, started[0]?.running, finished[0]?.running];
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise);
    assert.deepEqual(states, [undefined, true, false]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
