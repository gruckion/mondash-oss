import { enabled } from "../profile";
import { Effect, Option, Redacted, Schema } from "effect";
import { ServerConfig } from "@/config";
import { FETCH_TIMEOUT } from "@/lib/timeouts";
import { withBackoff } from "@/services/retry";

/** Jev is not set up, refused, or did not answer. */
export class JevFailure extends Schema.TaggedError<JevFailure>()("JevFailure", {
  message: Schema.String,
  /** The HTTP status when Jev answered with an error. */
  status: Schema.optional(Schema.Finite),
  cause: Schema.optional(Schema.Defect()),
}) {}

/** Rate limits, server errors and dropped connections. A timed-out question is not asked again: it can take a minute. */
export const transientJev = (failure: JevFailure): boolean =>
  failure.status === undefined ? failure.cause instanceof TypeError : failure.status === 429 || failure.status >= 500;

const reason = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Asks Jev one question about `state` and returns its answer. See docs/jev.md. */
export const ask = (state: unknown, questions: Record<string, unknown>) =>
  Effect.gen(function* () {
    if (!enabled("classification")) return yield* new JevFailure({ message: "Classification is disabled" });
    const { typesafe } = yield* ServerConfig;
    if (Option.isNone(typesafe))
      return yield* new JevFailure({ message: "Set TYPESAFE_API_KEY and TYPESAFE_MODEL in .env" });
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch("https://api.typesafe.ai/v1/systemone", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${Redacted.value(typesafe.value.apiKey)}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model: typesafe.value.model, state, questions }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT)]),
        }),
      catch: (cause) => new JevFailure({ message: `Jev did not answer: ${reason(cause)}`, cause }),
    });
    if (!response.ok) {
      const body = yield* Effect.promise(() => response.text().catch(() => ""));
      return yield* new JevFailure({
        message: `Jev returned HTTP ${response.status}: ${body.slice(0, 300)}`,
        status: response.status,
      });
    }
    const json: unknown = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) => new JevFailure({ message: `Jev's answer is not JSON: ${reason(cause)}`, cause }),
    });
    return json;
  }).pipe(withBackoff({ retryable: transientJev, base: "2 seconds", times: 2 }));

const NoulAnswer = Schema.Struct({ answers: Schema.Struct({ q: Schema.Struct({ noul: Schema.Finite }) }) });
const decodeNoulAnswer = Schema.decodeUnknownEffect(NoulAnswer);
const ChoiceAnswer = Schema.Struct({
  answers: Schema.Struct({ q: Schema.Struct({ probabilities: Schema.Record(Schema.String, Schema.Finite) }) }),
});
const decodeChoiceAnswer = Schema.decodeUnknownEffect(ChoiceAnswer);

/** Probability (0 to 1) that the answer to the yes/no question is yes. */
export const noul = Effect.fn("jev.noul")(function* (state: unknown, criteria: { true: string; false: string }) {
  const answer = yield* decodeNoulAnswer(yield* ask(state, { q: { type: "noul", criteria } }));
  return answer.answers.q.noul;
});

/** Probability of each option; they sum to 1. For options that compete, e.g. which ticket a session is about. */
export const choice = Effect.fn("jev.choice")(function* (
  state: unknown,
  criteria: Record<string, string>,
  goal: string,
) {
  const answer = yield* decodeChoiceAnswer(
    yield* ask(state, { q: { type: "choice", criteria, instructions: { goal } } }),
  );
  return answer.answers.q.probabilities;
});

const ScoreAnswers = Schema.Struct({
  answers: Schema.Record(
    Schema.String,
    Schema.Struct({
      score: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
      confidence: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
    }),
  ),
});

/** Independent relevance questions share a request; several sessions may be equally good matches. */
export const scoreMany = Effect.fn("jev.scoreMany")(function* (
  state: unknown,
  questions: Record<string, { type: "score"; criteria: readonly string[]; instructions: unknown }>,
) {
  return (yield* Schema.decodeUnknownEffect(ScoreAnswers)(yield* ask(state, questions))).answers;
});

const Probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const FourLevels = Schema.Struct({ "0": Probability, "1": Probability, "2": Probability, "3": Probability });
const DistributionAnswer = Schema.Struct({
  answers: Schema.Struct({ q: Schema.Struct({ probabilities: FourLevels }) }),
});

/** A four-level Score distribution. Confidence and the expected numeric score are not association probabilities. */
export const scoreDistribution = Effect.fn("jev.scoreDistribution")(function* (
  state: unknown,
  criteria: readonly [string, string, string, string],
  goal: string,
) {
  const answer = yield* Schema.decodeUnknownEffect(DistributionAnswer)(
    yield* ask(state, { q: { type: "score", criteria, instructions: { goal } } }),
  );
  const probabilities = answer.answers.q.probabilities;
  const total = Object.values(probabilities).reduce((sum, p) => sum + p, 0);
  if (Math.abs(total - 1) > 0.02)
    return yield* new JevFailure({ message: "Jev returned an invalid Score probability distribution" });
  return probabilities;
});
