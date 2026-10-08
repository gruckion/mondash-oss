import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Logger, Option, Redacted, Schema } from "effect";
import { ServerConfig } from "@/config";
import { Store, storeKey } from "@/services/store";
import type { AgentSession } from "./sessions";
import { matchSessions, ScoredSessions, type WorkItem } from "./session-match";

const item: WorkItem = {
  key: "DEMO-1",
  kind: "Linear ticket",
  title: "WebP export",
  status: "In Progress",
  refs: ["ticket:DEMO-1"],
};
const session: AgentSession = {
  tool: "codex",
  id: "bc565f14-3610-5145-8774-989b5dad52bb",
  title: "Investigate image export formats",
  firstPrompt: "Find the image export encoder",
  lastPrompt: "tldr",
  preview: "Done",
  cwd: "/repo",
  refs: { "ticket:DEMO-1": 8 },
  promptRefs: {},
  updatedAt: new Date("2026-10-08T10:00:00Z"),
};
const settings = {
  host: "127.0.0.1",
  port: 0,
  expoGoUrl: "",
  ntfy: { topic: Option.none(), server: "" },
  slackAppToken: Option.none(),
  slackClient: Option.none(),
  typesafe: Option.some({ apiKey: Redacted.make("test-key"), model: "test-model" }),
  terminalApp: "Terminal",
  claudeBin: Option.none(),
  newSessionDir: "/tmp",
  otlpUrl: Option.none(),
  publicUrl: Option.none(),
  linearApiKey: Option.none(),
};
const config = Layer.succeed(ServerConfig, ServerConfig.of(settings));
const record = (role: string, text: string) =>
  JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    },
  }) + "\n";
const response = (p: number) =>
  new Response(JSON.stringify({ answers: { q: { noul: p, probabilities: { "0": 1 - p, "1": 0, "2": p, "3": 0 } } } }));

test("adaptive matching routes uncertainty, keeps independent items, and fails closed on bad answers", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mondash-match-"));
  try {
    const file = join(dir, `${session.id}.jsonl`);
    await writeFile(
      file,
      record("user", "# AGENTS.md instructions for /repo\nDEMO-SECRET invented context") +
        record("user", "Find the image export encoder") +
        record("assistant", "It exports PNG images.") +
        record("user", "Create the WebP export ticket") +
        record("assistant", "Created DEMO-1 and the WebP export PRs."),
    );
    const scenarios = [
      { key: "DEMO-1", first: 0.6, second: 0.93, accepted: true },
      { key: "DEMO-2", first: 0.9, accepted: true },
      { key: "DEMO-3", first: 0.1, accepted: false },
      { key: "DEMO-4", first: 0.89, second: 0.05, accepted: false },
      { key: "DEMO-5", first: 0.6, second: 0.7, accepted: true },
      { key: "DEMO-6", first: 0.6, second: 0.69, accepted: false },
      { key: "DEMO-7", first: 0.6, second: "invalid", accepted: false },
      { key: "DEMO-8", first: 0.6, second: "error", accepted: false },
    ] as const;
    const requests: {
      state: { target: { key: string }; work_exchanges?: { user: string; assistant: string }[] };
      questions: { q: { type: string } };
    }[] = [];
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      requests.push(body);
      assert.equal(body.questions.q.type, "score");
      const found = scenarios.find((s) => s.key === body.state.target.key)!;
      const p = body.state.work_exchanges ? ("second" in found ? found.second : undefined) : found.first;
      if (p === "invalid") return new Response(JSON.stringify({ answers: { q: { score: 3, confidence: 1 } } }));
      if (p === "error") return new Response("No", { status: 400 });
      assert.equal(typeof p, "number");
      return response(p as number);
    });
    const items = scenarios.map((s) => ({ ...item, key: s.key, refs: [`ticket:${s.key}`] }));
    const candidate = { ...session, refs: Object.fromEntries(items.map((i) => [i.refs[0], 8])) };
    const result = await Effect.gen(function* () {
      yield* (yield* Store).write(storeKey("session-evidence-files:v1", Schema.Array(Schema.String)), [file]);
      return yield* matchSessions(items, [candidate]);
    }).pipe(Effect.scoped, Effect.provide([Store.layerMemory, config, Logger.layer([])]), Effect.runPromise);
    assert.deepEqual(
      [...result.keys()],
      scenarios.filter((s) => s.accepted).map((s) => s.key),
    );
    assert.equal(result.get("DEMO-1")?.[0].jev, 0.93);
    assert.equal(requests.length, 14);
    const rich = requests.find((r) => r.state.target.key === "DEMO-1" && r.state.work_exchanges)!;
    assert.ok(
      rich.state.work_exchanges?.some(
        (e) => e.user.includes("Create the WebP export ticket") && e.assistant.includes("Created DEMO-1"),
      ),
    );
    assert.ok(!JSON.stringify(requests).includes("DEMO-SECRET"));
  } finally {
    t.mock.restoreAll();
    await rm(dir, { recursive: true, force: true });
  }
});

test("new selected evidence and model changes invalidate a cached rejection; unchanged evidence reuses it", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mondash-match-cache-"));
  try {
    const file = join(dir, `${session.id}.jsonl`);
    await writeFile(file, record("user", "Investigate DEMO-1") + record("assistant", "Only referenced DEMO-1"));
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return response(calls === 1 ? 0.05 : 0.99);
    });
    const results = await Effect.gen(function* () {
      yield* (yield* Store).write(storeKey("session-evidence-files:v1", Schema.Array(Schema.String)), [file]);
      const first = yield* matchSessions([item], [session]);
      yield* matchSessions([item], [{ ...session, updatedAt: new Date(), refs: { "ticket:DEMO-1": 90 } }]);
      assert.equal(calls, 1);
      yield* Effect.promise(() =>
        appendFile(file, record("user", "Implement DEMO-1") + record("assistant", "Delivered DEMO-1")),
      );
      const changed = yield* matchSessions([item], [session]);
      assert.equal(calls, 2);
      yield* matchSessions([item], [session]).pipe(
        Effect.provideService(ServerConfig, {
          ...settings,
          typesafe: Option.some({ apiKey: Redacted.make("test-key"), model: "another-model" }),
        }),
      );
      assert.equal(calls, 3);
      return [first, changed];
    }).pipe(Effect.scoped, Effect.provide([Store.layerMemory, config, Logger.layer([])]), Effect.runPromise);
    assert.equal(results[0].size, 0);
    assert.equal(results[1].get(item.key)?.[0].jev, 0.99);
  } finally {
    t.mock.restoreAll();
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing Jev configuration cannot invent links", async () => {
  const result = await matchSessions([item], [{ ...session, id: "unavailable" }]).pipe(
    Effect.scoped,
    Effect.provide([
      Store.layerMemory,
      Layer.succeed(ServerConfig, { ...settings, typesafe: Option.none() }),
      Logger.layer([]),
    ]),
    Effect.runPromise,
  );
  assert.equal(result.size, 0);
});

test("cached work items survive but associations from previous rules are discarded", async () => {
  const schema = Schema.Struct({ title: Schema.String, sessions: ScoredSessions });
  const key = storeKey("cached-work", schema);
  const read = await Effect.gen(function* () {
    const store = yield* Store;
    yield* store.write(storeKey(key.name, Schema.Unknown), {
      title: "Keep document versions",
      sessions: [{ ...session, updatedAt: session.updatedAt.toISOString(), jev: 0.95, associationVersion: 1 }],
    });
    const old = (yield* store.read(key))?.value;
    yield* store.write(key, {
      title: "Keep document versions",
      sessions: [{ ...session, jev: 0.9, associationVersion: 2 }],
    });
    return [old, (yield* store.read(key))?.value];
  }).pipe(Effect.scoped, Effect.provide(Store.layerMemory), Effect.runPromise);
  assert.deepEqual(read[0], { title: "Keep document versions", sessions: [] });
  assert.equal(read[1]?.sessions[0]?.jev, 0.9);
});
