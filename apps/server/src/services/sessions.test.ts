import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Layer, Option } from "effect";
import { ServerConfig } from "@/config";
import type { Kickoff } from "@/lib/claude-remote";
import { Claude } from "./claude";
import { Sessions } from "./sessions";
import { Store } from "./store";
import { Gh } from "./gh";

const unused = Effect.die(new Error("not called in this test"));

/** Sessions with a Claude that records the sessions it is asked to start. */
function harness() {
  const started: { name: string; prompt: string }[] = [];
  const layer = Sessions.layer.pipe(
    Layer.provide([
      Layer.succeed(
        Claude,
        Claude.of({
          openSession: () => unused,
          startReview: () => unused,
          previewReview: () => unused,
          newSession: unused,
          reviewLaunches: unused,
          startSession: (name, prompt) =>
            Effect.sync(() => {
              started.push({ name, prompt });
              return "https://claude.ai/code/session_Test";
            }),
        }),
      ),
      Layer.succeed(
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
      ),
      Store.layerMemory,
      Layer.succeed(Gh, Gh.of({ json: () => unused })),
    ]),
  );
  const run = <A>(use: (sessions: typeof Sessions.Service) => Effect.Effect<A, unknown>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* use(yield* Sessions);
      }).pipe(Effect.provide(layer)),
    );
  return { started, run };
}

const requests: Kickoff[] = [
  { kind: "ticket", ticketId: "DEMO-4214", url: "https://linear.app/example/issue/DEMO-4214/plan", prs: [] },
  {
    kind: "ticket",
    ticketId: "DEMO-4214",
    url: "https://linear.app/example/issue/DEMO-4214/plan",
    prs: ["https://github.com/ExampleOrg/core/pull/2303"],
  },
  { kind: "pr", url: "https://github.com/ExampleOrg/web/pull/1856" },
];

test("the prompt preview is exactly the first message a start sends", async () => {
  for (const request of requests) {
    const { started, run } = harness();
    const preview = await run((sessions) => sessions.kickoffPrompt(request));
    await run((sessions) => sessions.startKickoff(request));
    assert.equal(started.length, 1);
    assert.equal(started[0].prompt, preview);
  }
});

test("an edited prompt replaces the first message, and the session keeps its usual name", async () => {
  const { started, run } = harness();
  await run((sessions) => sessions.startKickoff(requests[1]));
  await run((sessions) => sessions.startKickoff(requests[1], "Only check the web PR."));
  assert.deepEqual(
    started.map(({ name }) => name),
    ["DEMO-4214 catch up", "DEMO-4214 catch up"],
  );
  assert.equal(started[1].prompt, "Only check the web PR.");
  assert.deepEqual(
    (await run((sessions) => sessions.startKickoff(requests[2], "Read it."))).url,
    "https://claude.ai/code/session_Test",
  );
  assert.deepEqual(started[2], { name: "web#1856 catch up", prompt: "Read it." });
});
