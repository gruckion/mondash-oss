import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Layer, Logger } from "effect";
import type { DebriefReport } from "@mondash/shared/contract";
import { makeDebriefs } from "./debriefs";
import { Store } from "./store";
import { REPORT_KEY } from "@/lib/debrief";
import { DebriefFailure } from "@/lib/debrief-model";
const range = { since: "2026-09-25T00:00:00Z", until: "2026-09-30T08:00:00Z" };
const report: DebriefReport = {
  ...range,
  id: "report",
  generatedAt: range.until,
  summary: "One action",
  items: [],
  scannedMessages: 1,
  scannedThreads: 1,
  warnings: [],
};
const run = <A, E>(effect: Effect.Effect<A, E, Store | import("effect").Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(Store.layerMemory, Logger.layer([]))), Effect.runPromise);

test("concurrent generation shares one job; failure keeps the last report and retry range", async () => {
  await run(
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      let calls = 0;
      yield* (yield* Store).write(REPORT_KEY, report);
      const service = yield* makeDebriefs(() =>
        Effect.gen(function* () {
          calls++;
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(gate);
          return yield* new DebriefFailure({ message: "No credits" });
        }),
      );
      yield* service.generate(range);
      yield* service.generate(range);
      assert.equal((yield* service.read).status, "running");
      yield* Deferred.await(started);
      assert.equal(calls, 1);
      yield* Deferred.succeed(gate, undefined);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      const state = yield* service.read;
      assert.equal(state.report?.id, "report");
      assert.equal(state.status, "failed");
      assert.equal(state.error, "No credits");
      assert.equal((yield* service.history).length, 1);
      assert.deepEqual(state.range, range);
    }),
  );
});

test("migrates the existing report, preserves successive reports and restores history on restart", async () => {
  await run(
    Effect.gen(function* () {
      yield* (yield* Store).write(REPORT_KEY, report);
      let count = 0;
      const build = () => Effect.succeed({ ...report, id: `new-${++count}` });
      const service = yield* makeDebriefs(build);
      assert.deepEqual(yield* service.report("report"), report);
      for (let i = 0; i < 2; i++) {
        yield* service.generate(range);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
      }
      const restarted = yield* makeDebriefs(build);
      assert.deepEqual(
        (yield* restarted.history).map((r) => r.id),
        ["new-2", "new-1", "report"],
      );
      assert.equal((yield* restarted.read).report?.id, "new-2");
      assert.equal((yield* restarted.report("new-1"))?.id, "new-1");
      assert.equal(yield* restarted.report("missing"), null);
    }),
  );
});
