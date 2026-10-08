import assert from "node:assert/strict";
import { test } from "node:test";
import { Data, Effect, Logger, Schema } from "effect";
import { TestClock } from "effect/testing";
import { Store, storeKey } from "@/services/store";
import { coalesced, pruneStore, watch } from "./live";

class SourceDown extends Data.TaggedError("SourceDown") {}

test("watch records the first answer, then runs onChange only when the answer changes, and survives a failed check", async () => {
  const answers = ["a", "a", "b", "fail", "b", "c"];
  let tick = 0;
  let changes = 0;
  const check = Effect.suspend(() => {
    const answer = answers[tick++];
    return answer === "fail" ? Effect.fail(new SourceDown()) : Effect.succeed(answer);
  });
  const onChange = Effect.sync(() => void changes++);

  const seen = await Effect.gen(function* () {
    yield* Effect.forkScoped(watch("github", "1 minute", check, onChange));
    const afterEachTick: number[] = [];
    for (let i = 0; i < answers.length; i++) {
      yield* Effect.yieldNow;
      afterEachTick.push(changes);
      if (i < answers.length - 1) yield* TestClock.adjust("1 minute");
    }
    return afterEachTick;
  }).pipe(Effect.scoped, Effect.provide([Store.layerMemory, TestClock.layer(), Logger.layer([])]), Effect.runPromise);

  // a (recorded), a (same), b (changed), fail (logged), b (same), c (changed)
  assert.deepEqual(seen, [0, 0, 1, 1, 1, 2]);
  assert.equal(tick, answers.length);
});

test("pruneStore deletes unused Jev rows, Jev answers older than 14 days and dead rows, and keeps the rest", async () => {
  const key = (name: string) => storeKey(name, Schema.String);
  const remaining = await Effect.gen(function* () {
    const store = yield* Store;
    const old = ["jev-dm:a", "jev-session-item:v2:a", "jev-triage:v1:a", "jev-card-ticket:v3:a"];
    for (const name of old) yield* store.write(key(name), "x");
    yield* TestClock.adjust("15 days");
    const recent = [
      "jev-session-choice:a",
      "jev-session-item:v1:a",
      "jev-session-item:v2:b",
      "jev-session-item:v3:b",
      "jev-dm:b",
      "mcp:linear:get_issue:{}",
      "mcp:notion:notion-fetch:{}",
      "live:notion",
      "live:github",
    ];
    for (const name of recent) yield* store.write(key(name), "x");

    assert.equal(yield* pruneStore, 9);
    const left: string[] = [];
    for (const name of [...old, ...recent]) if (yield* store.storedAt(name)) left.push(name);
    return left;
  }).pipe(Effect.scoped, Effect.provide([Store.layerMemory, TestClock.layer(), Logger.layer([])]), Effect.runPromise);

  assert.deepEqual(remaining, ["jev-session-item:v3:b", "jev-dm:b", "mcp:notion:notion-fetch:{}", "live:github"]);
});

test("coalesced runs once, 2 seconds after the first of a burst of calls, and again for a later call", async () => {
  const runs = await Effect.gen(function* () {
    const runs: number[] = [];
    const soon = coalesced(
      Effect.flatMap(
        Effect.clockWith((clock) => clock.currentTimeMillis),
        (now) => Effect.sync(() => runs.push(now)),
      ),
      "2 seconds",
      yield* Effect.scope,
    );
    yield* soon;
    yield* TestClock.adjust("1 second");
    yield* soon;
    yield* soon;
    yield* TestClock.adjust("1 second");
    assert.deepEqual(runs, [2000]);
    yield* TestClock.adjust("10 seconds");
    yield* soon;
    yield* TestClock.adjust("2 seconds");
    return runs;
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.runPromise);
  assert.deepEqual(runs, [2000, 14000]);
});
