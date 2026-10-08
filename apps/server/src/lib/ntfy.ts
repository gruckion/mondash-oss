import { Effect, Option, Redacted, Schema } from "effect";
import { ServerConfig } from "@/config";
import { FETCH_TIMEOUT } from "@/lib/timeouts";
import { withBackoff } from "@/services/retry";
/**
 * Phone alerts through ntfy (https://ntfy.sh): the Mac posts to a private topic and the ntfy app on the iPhone shows it.
 * No Apple Developer membership needed. The topic name is the only secret, so keep NTFY_TOPIC long and random.
 * Messages pass through ntfy.sh on their way to Apple; NTFY_SERVER points at a self-hosted server instead.
 */
/** ntfy refused the alert, or did not answer (no `status`). */
export class NtfyFailure extends Schema.TaggedError<NtfyFailure>()("NtfyFailure", {
  status: Schema.optional(Schema.Finite),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** Rate limits, server errors and dropped connections; a refused topic is not sent again. */
export const transientNtfy = (failure: NtfyFailure): boolean =>
  failure.status === undefined ? failure.cause instanceof TypeError : failure.status === 429 || failure.status >= 500;

export type Alert = { title: string; body: string; url?: string; tag?: string };

/** Does nothing until NTFY_TOPIC is set. */
export const notify = Effect.fn("ntfy.notify")(
  function* (alert: Alert) {
    const { ntfy } = yield* ServerConfig;
    if (Option.isNone(ntfy.topic)) return;
    const topic = ntfy.topic.value;
    // JSON, not headers: ntfy headers must be ASCII, and names like Renée are not.
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(ntfy.server, {
          method: "POST",
          signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT)]),
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            topic: Redacted.value(topic),
            title: alert.title,
            message: alert.body.slice(0, 900),
            ...(alert.url ? { click: alert.url } : {}),
            ...(alert.tag ? { tags: [alert.tag] } : {}),
          }),
        }),
      catch: (cause) =>
        new NtfyFailure({
          message: `ntfy did not answer: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        }),
    });
    if (!response.ok) {
      const body = yield* Effect.promise(() => response.text().catch(() => ""));
      return yield* new NtfyFailure({
        status: response.status,
        message: `ntfy returned HTTP ${response.status}: ${body.slice(0, 300)}`,
      });
    }
  },
  withBackoff({ retryable: transientNtfy }),
);
