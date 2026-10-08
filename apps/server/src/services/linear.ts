import { ConnectionSetup } from "../connection-setup";
import { enabled } from "../profile";
import { Clock, Context, DateTime, Effect, Layer, Option, Redacted, Schema } from "effect";
import { ServerConfig } from "@/config";
import { causeText } from "./errors";
import { Health, healthCurrent } from "./mcp";
import { withBackoff } from "./retry";
import { Store, storeKey, type StoreFailure } from "./store";
import { withIoSpan } from "@/tracing";

/** A Linear API call failed, timed out, or Linear refused it. */
export class LinearFailure extends Schema.TaggedError<LinearFailure>()("LinearFailure", {
  /** The HTTP status, when Linear answered. */
  status: Schema.optional(Schema.Finite),
  cause: Schema.Defect(),
}) {
  override get message() {
    return `Linear${this.status === undefined ? "" : ` ${this.status}`}: ${causeText(this.cause)}`;
  }
}

/** Rate limits, server errors, timeouts and dropped connections pass; a refused key or a bad query does not. */
export const transientLinear = (failure: LinearFailure): boolean =>
  failure.status === undefined
    ? failure.cause instanceof Error && (failure.cause.name === "TimeoutError" || failure.cause.name === "TypeError")
    : failure.status === 429 || failure.status >= 500;

const Answer = Schema.Struct({
  data: Schema.optional(Schema.NullOr(Schema.Unknown)),
  errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
});
const decodeAnswer = Schema.decodeUnknownEffect(Answer);
const healthKey = storeKey("health:linear", Health);

/** Linear's GraphQL API, with the personal API key in `LINEAR_API_KEY`. */
export class Linear extends Context.Service<
  Linear,
  {
    /** Runs a query or mutation and decodes its `data` with `schema`. Any GraphQL error fails the call. */
    query<A>(
      text: string,
      variables: Record<string, unknown>,
      schema: Schema.Codec<A, unknown>,
    ): Effect.Effect<A, LinearFailure>;
    readonly connected: boolean;
    /** Whether the last call worked, for Settings. */
    readonly health: Effect.Effect<Health | undefined, StoreFailure>;
  }
>()("mondash/server/Linear") {
  static readonly layer = Layer.effect(
    Linear,
    Effect.gen(function* () {
      const { linearApiKey } = yield* ServerConfig;
      const store = yield* Store;
      // Settings shows whether the last call worked, and when.
      const record = (ok: boolean, message?: string) =>
        Effect.gen(function* () {
          const before = yield* store.read(healthKey);
          if (healthCurrent(before?.value, ok, yield* Clock.currentTimeMillis)) return;
          const at = DateTime.formatIso(yield* DateTime.now);
          yield* store.write(healthKey, message === undefined ? { ok, at } : { ok, at, message });
        }).pipe(Effect.catch((failure) => Effect.logWarning("Could not record the Linear health", failure)));

      const send = (text: string, variables: Record<string, unknown>) =>
        Effect.gen(function* () {
          if (!enabled("linear") && !(yield* ConnectionSetup))
            return yield* new LinearFailure({ cause: new Error("Linear is disabled") });
          if (Option.isNone(linearApiKey))
            return yield* new LinearFailure({ cause: new Error("LINEAR_API_KEY is not set") });
          const key = Redacted.value(linearApiKey.value);
          const response = yield* Effect.tryPromise({
            try: (signal) =>
              fetch("https://api.linear.app/graphql", {
                method: "POST",
                headers: { "content-type": "application/json", authorization: key },
                body: JSON.stringify({ query: text, variables }),
                signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
              }),
            catch: (cause) => new LinearFailure({ cause }),
          });
          const body = yield* Effect.tryPromise({
            try: () => response.json(),
            catch: (cause) => new LinearFailure({ status: response.status, cause }),
          });
          const answer = yield* decodeAnswer(body).pipe(
            Effect.mapError((cause) => new LinearFailure({ status: response.status, cause })),
          );
          if (!response.ok || answer.errors?.length)
            return yield* new LinearFailure({
              status: response.status,
              cause: new Error(answer.errors?.map((e) => e.message).join("; ") ?? response.statusText),
            });
          return answer.data;
        });

      return Linear.of({
        connected: enabled("linear") && Option.isSome(linearApiKey),
        health: store.read(healthKey).pipe(Effect.map((stored) => stored?.value)),
        query: (text, variables, schema) =>
          send(text, variables).pipe(
            withBackoff({ retryable: transientLinear }),
            Effect.flatMap((data) =>
              Schema.decodeUnknownEffect(schema)(data).pipe(Effect.mapError((cause) => new LinearFailure({ cause }))),
            ),
            Effect.tap(() => record(true)),
            Effect.tapError((failure) => record(false, failure.message.slice(0, 200))),
            withIoSpan("Linear.query", { attributes: { operation: text.match(/^\s*(\w+\s+\w+)/)?.[1] } }),
          ),
      });
    }),
  );
}
