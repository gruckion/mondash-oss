import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Fiber } from "effect";
import { Gh } from "@/services/gh";
import { Linear } from "@/services/linear";
import { Store } from "@/services/store";
import { FEED_KEY } from "./github-feed.ts";
import { resolveReviewScope } from "./review-scope-github.ts";

const unused = Effect.die(new Error("not called in this test"));
const linear = Linear.of({ connected: false, health: Effect.succeed(undefined), query: () => unused });

test("interrupting the scope check stops the gh call in flight and starts no more", async () => {
  let calls = 0;
  let stopped = 0;
  const started = Promise.withResolvers<void>();
  const gh = Gh.of({
    json: () =>
      Effect.suspend(() => {
        calls++;
        started.resolve();
        return Effect.never;
      }).pipe(Effect.onInterrupt(() => Effect.sync(() => stopped++))),
  });
  const fiber = Effect.runFork(
    resolveReviewScope("https://github.com/ExampleOrg/web/pull/1").pipe(
      Effect.provideService(Gh, gh),
      Effect.provideService(Linear, linear),
      Effect.provide(Store.layerMemory),
    ),
  );
  await started.promise;
  await Effect.runPromise(Fiber.interrupt(fiber));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stopped, 1);
  assert.equal(calls, 1);
});

test("the review groups come from the stored review feed, with no GitHub query", async () => {
  let calls = 0;
  const failure = await Effect.gen(function* () {
    yield* (yield* Store).write(FEED_KEY, { groups: [], seen: [] });
    return yield* Effect.flip(resolveReviewScope("https://github.com/ExampleOrg/web/pull/1"));
  }).pipe(
    Effect.provideService(
      Gh,
      Gh.of({
        json: () =>
          Effect.suspend(() => {
            calls++;
            return unused;
          }),
      }),
    ),
    Effect.provideService(Linear, linear),
    Effect.provide(Store.layerMemory),
    Effect.runPromise,
  );
  assert.match(failure.message, /no longer in Reviews/);
  assert.equal(calls, 0);
});
