import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, appendFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { Store } from "@/services/store";
import { readEvidence, mergeEvidence } from "./session-evidence";

const codex = (role: string, text: string, channel?: string) =>
  JSON.stringify({
    type: "response_item",
    timestamp: "2026-10-08T10:00:00Z",
    payload: {
      type: "message",
      role,
      channel,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    },
  }) + "\n";
const claude = (type: string, text: string, extra = {}) =>
  JSON.stringify({ type, ...extra, message: { content: [{ type: "text", text }] } }) + "\n";

test("evidence survives partial appends and rotation without retaining tool output, injected prompts or reasoning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mondash-evidence-"));
  const file = join(dir, "session.jsonl");
  try {
    const partial = Buffer.from(codex("assistant", "Delivered DEMO-1 ✓"));
    const prefix = [
      codex("developer", "SECRET developer instructions"),
      codex("user", "# AGENTS.md instructions for /repo\nSECRET repository instructions"),
      codex("user", "<environment_context>SECRET environment"),
      codex("user", '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>'),
      codex("user", "<command-name>/compact</command-name>"),
      codex("assistant", "SECRET reasoning", "analysis"),
      JSON.stringify({
        type: "response_item",
        payload: { type: "function_call_output", output: "SECRET tool " + "x".repeat(4 * 1024 * 1024) },
      }) + "\n",
      codex("user", "Implement DEMO-1, updating AGENTS.md"),
    ].join("");
    await writeFile(file, Buffer.concat([Buffer.from(prefix), partial.subarray(0, partial.length - 4)]));
    await Effect.gen(function* () {
      const initial = yield* readEvidence(file, "codex");
      assert.deepEqual(
        initial.map((m) => m.text),
        ["Implement DEMO-1, updating AGENTS.md"],
      );
      yield* Effect.promise(() => appendFile(file, partial.subarray(partial.length - 4)));
      const appended = yield* readEvidence(file, "codex");
      assert.deepEqual(
        appended.map((m) => m.text),
        ["Implement DEMO-1, updating AGENTS.md", "Delivered DEMO-1 ✓"],
      );
      assert.deepEqual(yield* readEvidence(file, "codex"), appended);
      yield* Effect.promise(() => writeFile(file, codex("user", "Replacement")));
      assert.deepEqual(
        (yield* readEvidence(file, "codex")).map((m) => m.text),
        ["Replacement"],
      );
      yield* Effect.promise(async () => {
        await writeFile(file + ".new", codex("user", "Rotated longer file has fresh evidence"));
        await rename(file + ".new", file);
      });
      assert.deepEqual(
        (yield* readEvidence(file, "codex")).map((m) => m.text),
        ["Rotated longer file has fresh evidence"],
      );
    }).pipe(Effect.scoped, Effect.provide(Store.layerMemory), Effect.runPromise);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude summaries remain context and continuation evidence keeps genuine repeated requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mondash-evidence-"));
  const file = join(dir, "claude.jsonl");
  try {
    await writeFile(
      file,
      claude("user", "# AGENTS.md instructions for /repo\nSECRET instructions") +
        claude("user", "<INSTRUCTIONS>SECRET instructions") +
        claude("user", "SECRET sidechain", { isSidechain: true }) +
        claude("user", "SECRET meta", { isMeta: true }) +
        claude("user", "Work on DEMO-1", { timestamp: "1" }) +
        claude("assistant", "Done DEMO-1", { timestamp: "2" }) +
        claude("user", "This session is being continued with DEMO-2", { isCompactSummary: true, timestamp: "3" }) +
        claude("user", "Work on DEMO-1", { timestamp: "4" }),
    );
    const messages = await readEvidence(file, "claude").pipe(
      Effect.scoped,
      Effect.provide(Store.layerMemory),
      Effect.runPromise,
    );
    assert.deepEqual(
      messages.map((m) => m.role),
      ["user", "assistant", "context", "user"],
    );
    assert.ok(!JSON.stringify(messages).includes("SECRET"));
    assert.deepEqual(mergeEvidence([messages, messages.slice(2)]), messages);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("markup requests survive extraction while JSON, env and bearer credentials stay local", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mondash-evidence-secrets-"));
  const file = join(dir, "session.jsonl");
  try {
    await writeFile(
      file,
      codex("user", "<form>Fix this layout</form>") +
        codex(
          "assistant",
          'Configuration {"api_key": "secret-one"}, TYPESAFE_API_KEY=secret-two, token: secret-three, Authorization: Bearer secret-four',
        ),
    );
    const messages = await readEvidence(file, "codex").pipe(
      Effect.scoped,
      Effect.provide(Store.layerMemory),
      Effect.runPromise,
    );
    assert.equal(messages[0]?.text, "<form>Fix this layout</form>");
    const text = JSON.stringify(messages);
    for (const secret of ["secret-one", "secret-two", "secret-three", "secret-four"])
      assert.ok(!text.includes(secret), secret);
    assert.ok(text.includes("Configuration"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
