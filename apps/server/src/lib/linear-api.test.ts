import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Fiber, Logger, Schema } from "effect";
import { TestClock } from "effect/testing";
import { Linear, LinearFailure } from "@/services/linear";
import { ReadOnly, Store } from "@/services/store";
import { issueById, issuesById } from "./linear-api";

const node = (identifier: string) => ({
  identifier,
  title: "Found",
  url: `https://linear.app/example/issue/${identifier}`,
  updatedAt: "2026-09-28T10:00:00.000Z",
  createdAt: "2026-09-28T10:00:00.000Z",
  completedAt: null,
  canceledAt: null,
  description: null,
  priority: 0,
  priorityLabel: "No priority",
  state: { name: "Todo", type: "unstarted" },
  assignee: null,
  labels: { nodes: [] },
  attachments: { nodes: [] },
  project: null,
});

/**
 * A Linear that knows `issues`, records each ByNumber query as "TEAM:numbers", fails the teams in `down`, and holds
 * every answer until `gate` opens, when there is one.
 */
const fakeLinear = (issues: ReadonlyArray<string>, down: ReadonlySet<string>, gate?: Deferred.Deferred<void>) => {
  const calls: string[] = [];
  const linear = Linear.of({
    connected: true,
    health: Effect.succeed(undefined),
    query: (_text, variables, schema) =>
      Effect.gen(function* () {
        const team = String(variables.team);
        const numbers = String(variables.numbers).split(",");
        calls.push(`${team}:${numbers.join(",")}`);
        if (gate) yield* Deferred.await(gate);
        if (down.has(team))
          return yield* new LinearFailure({ status: 502, cause: new Error("Linear is temporarily unavailable") });
        const nodes = issues.filter((id) => numbers.some((n) => id === `${team}-${n}`)).map(node);
        return yield* Schema.decodeUnknownEffect(schema)({ issues: { nodes } }).pipe(Effect.orDie);
      }),
  });
  return { linear, calls };
};

const run = <A, E>(linear: Linear["Service"], effect: Effect.Effect<A, E, Store | Linear>) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide([Store.layerMemory, TestClock.layer(), Logger.layer([])]),
    Effect.provideService(Linear, linear),
    Effect.runPromise,
  );

/** Lets forked fibers (a background refresh) run. */
const settle = Effect.gen(function* () {
  for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
});

test("an ID Linear has no issue for is not a ticket, and is not asked about again; an outage fails", async () => {
  const { linear, calls } = fakeLinear(["DEMO-2"], new Set(["ENG"]));
  const { notFound, again, down, found } = await run(
    linear,
    Effect.gen(function* () {
      return {
        notFound: yield* issueById("ISO-8601"),
        again: yield* issueById("ISO-8601"),
        down: yield* issueById("ENG-1").pipe(Effect.flip),
        found: yield* issueById("DEMO-2"),
      };
    }),
  );
  assert.equal(notFound, undefined);
  assert.equal(again, undefined);
  assert.match(down.message, /temporarily unavailable/);
  assert.equal(found?.id, "DEMO-2");
  assert.deepEqual(calls, ["ISO:8601", "ENG:1", "DEMO:2"]);
});

test("one request per team for every ID due, and a concurrent caller shares it", async () => {
  const { first, second, calls } = await Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const { linear, calls } = fakeLinear(["DEMO-1", "DEMO-2", "ENG-3"], new Set(), gate);
    return yield* Effect.gen(function* () {
      const first = yield* Effect.forkChild(issuesById(["DEMO-1", "DEMO-2", "ENG-3", "DEMO-1", "not an ID"]));
      yield* settle;
      const second = yield* Effect.forkChild(issuesById(["DEMO-1"]));
      yield* settle;
      yield* Deferred.succeed(gate, undefined);
      return { first: yield* Fiber.join(first), second: yield* Fiber.join(second), calls };
    }).pipe(Effect.provideService(Linear, linear));
  }).pipe(Effect.scoped, Effect.provide([Store.layerMemory, TestClock.layer(), Logger.layer([])]), Effect.runPromise);
  assert.deepEqual(calls.toSorted(), ["DEMO:1,2", "ENG:3"]);
  assert.deepEqual([...first.keys()].toSorted(), ["DEMO-1", "DEMO-2", "ENG-3"]);
  assert.deepEqual([...second.keys()], ["DEMO-1"]);
});

test("a ticket is kept 30 minutes and a non-ticket a day; under ReadOnly only stored rows answer", async () => {
  const { linear, calls } = fakeLinear(["DEMO-1", "DEMO-5"], new Set());
  const seen = await run(
    linear,
    Effect.gen(function* () {
      const seen: Array<{ found: string[]; calls: number }> = [];
      const look = (ids: string[]) =>
        Effect.gen(function* () {
          const found = yield* issuesById(ids);
          yield* settle;
          seen.push({ found: [...found.keys()], calls: calls.length });
        });
      yield* look(["DEMO-1", "ISO-8601"]);
      yield* TestClock.adjust("29 minutes");
      yield* look(["DEMO-1", "ISO-8601"]);
      yield* look(["DEMO-1", "DEMO-5"]).pipe(Effect.provideService(ReadOnly, true));
      yield* TestClock.adjust("2 minutes");
      // Past 30 minutes: the stored ticket answers now and is fetched again behind it.
      yield* look(["DEMO-1", "ISO-8601"]);
      yield* TestClock.adjust("1 day");
      yield* look(["ISO-8601"]);
      return seen;
    }),
  );
  assert.deepEqual(seen, [
    { found: ["DEMO-1"], calls: 2 },
    { found: ["DEMO-1"], calls: 2 },
    { found: ["DEMO-1"], calls: 2 },
    { found: ["DEMO-1"], calls: 3 },
    { found: [], calls: 4 },
  ]);
  assert.deepEqual(calls, ["DEMO:1", "ISO:8601", "DEMO:1", "ISO:8601"]);
});

test("after a failed lookup the ID is not asked about again until the store's backoff passes", async () => {
  const { linear, calls } = fakeLinear([], new Set(["ENG"]));
  const failures = await run(
    linear,
    Effect.gen(function* () {
      const first = yield* issuesById(["ENG-1"]).pipe(Effect.flip);
      const blocked = yield* issuesById(["ENG-1"]).pipe(Effect.flip);
      yield* TestClock.adjust("3 minutes");
      const again = yield* issuesById(["ENG-1"]).pipe(Effect.flip);
      return [first._tag, blocked._tag, again._tag];
    }),
  );
  assert.deepEqual(failures, ["LinearFailure", "StoreFailure", "LinearFailure"]);
  assert.deepEqual(calls, ["ENG:1", "ENG:1"]);
});
