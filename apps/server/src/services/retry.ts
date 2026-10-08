import { Duration, Effect, Schedule } from "effect";

export interface BackoffOptions<E> {
  /** Whether the failure is worth another try: a rate limit, a 5xx, a dropped connection. */
  readonly retryable: (error: E) => boolean;
  /** How long the provider asked to wait (Retry-After), if it said. */
  readonly retryAfter?: (error: E) => Duration.Duration | undefined;
  /** Retries after the first attempt. */
  readonly times?: number;
  /** The first backoff step; each retry doubles it, with jitter. */
  readonly base?: Duration.Input;
  /**
   * The longest Retry-After worth waiting out inside one call. A longer one fails the call at once, and the Store's
   * backoff spaces out the next attempt instead of holding a request open.
   */
  readonly maxWait?: Duration.Input;
}

/**
 * Retries a flaky or rate-limited call: jittered exponential backoff, never sooner than the provider's Retry-After, a
 * few times, and only for the failures `retryable` accepts.
 */
export const withBackoff =
  <E>(options: BackoffOptions<E>) =>
  <A, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
    const retryAfter = (error: E) => (options.retryAfter ? options.retryAfter(error) : undefined);
    const maxWait = Duration.fromInputUnsafe(options.maxWait ?? "30 seconds");
    const exponential: Schedule.Schedule<Duration.Duration, E> = Schedule.exponential(
      options.base ?? "500 millis",
    ).pipe(Schedule.jittered);
    const schedule = Schedule.max([
      exponential.pipe(
        Schedule.modifyDelay(({ input, duration }) => {
          const asked = retryAfter(input);
          return Effect.succeed(asked ? Duration.max(duration, asked) : duration);
        }),
      ),
      Schedule.recurs(options.times ?? 3),
    ]);
    return self.pipe(
      Effect.retry({
        schedule,
        while: (error) => {
          if (!options.retryable(error)) return false;
          const asked = retryAfter(error);
          return asked === undefined || Duration.isLessThanOrEqualTo(asked, maxWait);
        },
      }),
    );
  };
