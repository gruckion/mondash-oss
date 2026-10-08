import assert from "node:assert/strict";
import { test } from "node:test";
import { Data, Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { withBackoff } from "./retry";

class Refused extends Data.TaggedError("Refused")<{ readonly retryable: boolean; readonly retryAfter?: number }> {}

const backoff = withBackoff<Refused>({
  retryable: (error) => error.retryable,
  retryAfter: (error) => (error.retryAfter === undefined ? undefined : Duration.seconds(error.retryAfter)),
  times: 3,
  maxWait: "30 seconds",
});

/** Fails with each of `failures` in turn, then succeeds; counts the attempts. */
const flaky = (failures: ReadonlyArray<Refused>) => {
  let attempts = 0;
  const call = Effect.suspend(() => {
    const failure = failures[attempts++];
    return failure ? Effect.fail(failure) : Effect.succeed("ok");
  });
  return { call, attempts: () => attempts };
};

test("a transient failure is retried after the provider's Retry-After, not sooner", async () => {
  const { call, attempts } = flaky([new Refused({ retryable: true, retryAfter: 10 })]);
  const result = await Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(call.pipe(backoff));
    yield* TestClock.adjust("9 seconds");
    const early = attempts();
    yield* TestClock.adjust("2 seconds");
    return { early, value: yield* Fiber.join(fiber) };
  }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise);
  assert.equal(result.early, 1);
  assert.equal(result.value, "ok");
  assert.equal(attempts(), 2);
});

test("a failure that is not transient is not retried", async () => {
  const { call, attempts } = flaky([new Refused({ retryable: false })]);
  const exit = await call.pipe(backoff, Effect.exit, Effect.provide(TestClock.layer()), Effect.runPromise);
  assert.equal(exit._tag, "Failure");
  assert.equal(attempts(), 1);
});

test("a Retry-After longer than the wait limit fails at once, for the Store's backoff to handle", async () => {
  const { call, attempts } = flaky([new Refused({ retryable: true, retryAfter: 288 })]);
  const exit = await call.pipe(backoff, Effect.exit, Effect.provide(TestClock.layer()), Effect.runPromise);
  assert.equal(exit._tag, "Failure");
  assert.equal(attempts(), 1);
});

test("retries stop after the set number of attempts", async () => {
  const always = Array.from({ length: 10 }, () => new Refused({ retryable: true }));
  const { call, attempts } = flaky(always);
  const exit = await Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(call.pipe(backoff, Effect.exit));
    yield* TestClock.adjust("5 minutes");
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise);
  assert.equal(exit._tag, "Failure");
  assert.equal(attempts(), 4);
});
