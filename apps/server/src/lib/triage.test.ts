import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Layer, Logger, Option, Schema } from "effect";
import { ServerConfig } from "@/config";
import { Linear } from "@/services/linear";
import { Store } from "@/services/store";
import { Mcp, McpFailure } from "@/services/mcp";
import { buildTriage, needsYouChance, needsYouKey } from "./triage";

// No Jev key, so every Jev call fails without leaving the machine.
const NoJev = Layer.succeed(
  ServerConfig,
  ServerConfig.of({
    host: "127.0.0.1",
    port: 0,
    expoGoUrl: "exp://phone.test:8081",
    ntfy: { topic: Option.none(), server: "https://ntfy.sh" },
    slackAppToken: Option.none(),
    slackClient: Option.none(),
    typesafe: Option.none(),
    terminalApp: "Terminal",
    claudeBin: Option.none(),
    newSessionDir: "/tmp",
    otlpUrl: Option.none(),
    publicUrl: Option.none(),
    linearApiKey: Option.none(),
  }),
);
const run = <A, E>(effect: Effect.Effect<A, E, Store | ServerConfig>) =>
  effect.pipe(Effect.provide([Store.layerMemory, NoJev, Logger.layer([])]), Effect.runPromise);

test("a Jev failure leaves one saved item without a verdict instead of failing", async () => {
  assert.equal(await run(needsYouChance("https://slack.test/p1", "can you look?", "2026-09-25")), undefined);
});

test("a saved thread's Jev verdict is reused while its text is the same", async () => {
  const chance = await run(
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.write(needsYouKey("https://slack.test/p1", "can you look?"), 0.8);
      return yield* needsYouChance("https://slack.test/p1", "can you look?", "2026-09-25");
    }),
  );
  assert.equal(chance, 0.8);
});

test("saved items take their thread's verdict, from one ticket lookup and no Slack search of their own", async () => {
  const issue = (identifier: string, type: string, assignee: string | null) => ({
    identifier,
    title: "Ticket",
    url: `https://linear.app/example/issue/${identifier}`,
    updatedAt: "2026-09-28T10:00:00.000Z",
    createdAt: "2026-09-28T10:00:00.000Z",
    completedAt: null,
    canceledAt: null,
    description: null,
    priority: 2,
    priorityLabel: "High",
    state: { name: type, type },
    assignee: assignee === null ? null : { id: assignee, name: "Taylor Reed" },
    labels: { nodes: [] },
    attachments: { nodes: [] },
    project: null,
  });
  const queries: string[] = [];
  const linear = Linear.of({
    connected: true,
    health: Effect.succeed(undefined),
    query: (text, variables, schema) =>
      Effect.suspend(() => {
        const mine = text.includes("query Mine");
        if (!mine) queries.push(`${String(variables.team)}:${String(variables.numbers)}`);
        const answer = mine
          ? { viewer: { id: "me", email: "me@test", assignedIssues: { nodes: [] } } }
          : { issues: { nodes: [issue("DEMO-1", "started", "me"), issue("DEMO-9", "completed", null)] } };
        return Schema.decodeUnknownEffect(schema)(answer).pipe(Effect.orDie);
      }),
  });
  const unused = Effect.die("not used by Triage");
  const mcp = Mcp.of({
    signIn: () => unused,
    finishSignIn: () => unused,
    call: () => unused,
    accessToken: () => unused,
    hasTokens: () => unused,
    health: () => unused,
    probe: () => unused,
    cachedCall: (_server, _tool, args) =>
      args.channel_id === "C1"
        ? Effect.succeed(JSON.stringify({ messages: "Message TS: 100.000001\nPlease look at DEMO-1" }))
        : Effect.fail(new McpFailure({ server: "slack", cause: new Error("Slack is down") })),
  });
  const items = await buildTriage([
    { url: "https://slack.test/p1", slack: { channel: "C1", ts: "100.000001" } },
    { url: "https://slack.test/p2", slack: { channel: "C1", ts: "100.000005", threadTs: "100.000001" } },
    { url: "https://slack.test/p3", slack: { channel: "C2", ts: "200.000001" }, snippet: "Tracked in DEMO-9" },
  ]).pipe(
    Effect.scoped,
    Effect.provide([Store.layerMemory, NoJev, Logger.layer([])]),
    Effect.provideService(Linear, linear),
    Effect.provideService(Mcp, mcp),
    Effect.runPromise,
  );
  assert.deepEqual(queries, ["DEMO:1,9"]);
  assert.deepEqual(
    items.map((item) => [item.permalink, item.show, item.tickets.map((t) => `${t.id}${t.mine ? " (mine)" : ""}`)]),
    [
      ["https://slack.test/p1", true, ["DEMO-1 (mine)"]],
      ["https://slack.test/p2", true, ["DEMO-1 (mine)"]],
      ["https://slack.test/p3", false, ["DEMO-9"]],
    ],
  );
});
