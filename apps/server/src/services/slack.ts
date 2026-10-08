import { ConnectionSetup } from "../connection-setup";
import { enabled } from "../profile";
import { Context, Duration, Effect, Layer, Option, Schema } from "effect";
import { Mcp } from "./mcp";
import { causeText } from "./errors";
import { withBackoff } from "./retry";
import { withIoSpan } from "@/tracing";

/** A Slack Web API call failed, timed out, or Slack refused it. */
export class SlackFailure extends Schema.TaggedError<SlackFailure>()("SlackFailure", {
  method: Schema.String,
  /** Slack's own error (`ratelimited`, `invalid_auth`), or `http <status>` when its answer names none. */
  error: Schema.optional(Schema.String),
  /** The seconds Slack asked to wait before the next call (Retry-After). */
  retryAfter: Schema.optional(Schema.Finite),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    const wait = this.retryAfter === undefined ? "" : `, retry after ${this.retryAfter} s`;
    return `Slack ${this.method}: ${this.error === undefined ? causeText(this.cause) : this.error}${wait}`;
  }
}

/** Rate limits, server errors, timeouts and dropped connections pass; a refusal such as `invalid_auth` does not. */
export const transientSlack = (failure: SlackFailure): boolean =>
  failure.error === undefined
    ? failure.cause instanceof Error && (failure.cause.name === "TimeoutError" || failure.cause.name === "TypeError")
    : failure.error === "ratelimited" || /^http (429|5\d\d)$/.test(failure.error);

const backoff = withBackoff<SlackFailure>({
  retryable: transientSlack,
  retryAfter: (failure) => (failure.retryAfter === undefined ? undefined : Duration.seconds(failure.retryAfter)),
});

const Refused = Schema.Struct({ ok: Schema.Literal(false), error: Schema.optional(Schema.String) });
const decodeRefused = Schema.decodeUnknownOption(Refused);

/**
 * The Slack Web API, for data the Slack MCP tools do not return. It uses the MCP sign-in's OAuth token. The result is
 * the raw JSON of a successful answer; an HTTP error or `ok: false` fails with Slack's `error`.
 */
export class SlackApi extends Context.Service<
  SlackApi,
  {
    get(method: string, params: Record<string, string>): Effect.Effect<unknown, SlackFailure>;
    /** A form POST, for methods that change state or take long queries. */
    post(method: string, form: Record<string, string>): Effect.Effect<unknown, SlackFailure>;
  }
>()("mondash/server/SlackApi") {
  static readonly layer = Layer.effect(
    SlackApi,
    Effect.gen(function* () {
      const mcp = yield* Mcp;
      const request = (
        method: string,
        init: (token: string) => { url: string; init: RequestInit },
        retryAuth = true,
      ): Effect.Effect<unknown, SlackFailure> =>
        Effect.gen(function* () {
          if (!enabled("slack") && !(yield* ConnectionSetup))
            return yield* new SlackFailure({ method, cause: new Error("Slack is disabled") });
          const token = yield* mcp
            .accessToken("slack")
            .pipe(Effect.mapError((failure) => new SlackFailure({ method, cause: failure })));
          if (!token) return yield* new SlackFailure({ method, cause: new Error("Slack is not connected") });
          const { url, init: options } = init(token);
          const answer = yield* Effect.tryPromise({
            try: async (signal) => {
              const response = await fetch(url, {
                ...options,
                signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
              });
              const retryAfter = Number(response.headers.get("retry-after"));
              // A 429 can come without a JSON body.
              const json: unknown = await response.json().catch(() => undefined);
              return {
                ok: response.ok,
                status: response.status,
                retryAfter: response.headers.has("retry-after") && Number.isFinite(retryAfter) ? retryAfter : undefined,
                json,
              };
            },
            catch: (cause) => new SlackFailure({ method, cause }),
          });
          const refused = decodeRefused(answer.json);
          if (answer.ok && Option.isNone(refused)) return answer.json;
          if (
            retryAuth &&
            (answer.status === 401 ||
              (Option.isSome(refused) && ["token_expired", "invalid_auth"].includes(refused.value.error ?? "")))
          ) {
            yield* mcp
              .accessToken("slack", token)
              .pipe(Effect.mapError((cause) => new SlackFailure({ method, cause })));
            return yield* request(method, init, false);
          }
          return yield* new SlackFailure({
            method,
            error: Option.isSome(refused) && refused.value.error ? refused.value.error : `http ${answer.status}`,
            ...(answer.retryAfter === undefined ? {} : { retryAfter: answer.retryAfter }),
          });
        }).pipe(backoff, withIoSpan("Slack.api", { attributes: { method } }));
      return SlackApi.of({
        get: (method, params) =>
          request(method, (token) => ({
            url: `https://slack.com/api/${method}?${new URLSearchParams(params)}`,
            init: { headers: { Authorization: `Bearer ${token}` } },
          })),
        post: (method, form) =>
          request(method, (token) => ({
            url: `https://slack.com/api/${method}`,
            init: { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: new URLSearchParams(form) },
          })),
      });
    }),
  );
}
