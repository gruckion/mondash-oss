import { ConnectionSetup } from "../connection-setup";
import { enabled } from "../profile";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Clock, Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { causeText } from "./errors";
import { Health, healthCurrent } from "./mcp";
import { Store, storeKey } from "./store";
import { withBackoff } from "./retry";
import { withIoSpan } from "@/tracing";

const run = promisify(execFile);

/** A `gh` command failed, timed out, or printed JSON that did not fit. */
export class GhFailure extends Schema.TaggedError<GhFailure>()("GhFailure", {
  command: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message() {
    return `gh ${this.command}: ${causeText(this.cause)}`;
  }
}

/**
 * Retry dropped connections and REST 5xx responses. GraphQL gateway timeouts incur additional quota penalties, so
 * retrying the same expensive query makes exhaustion worse. Rate limits pause the bucket until GitHub's reset.
 */
export const transientGh = (failure: GhFailure): boolean => {
  const { cause } = failure;
  if (!(cause instanceof Error) || ("killed" in cause && cause.killed === true)) return false;
  const stderr = "stderr" in cause && typeof cause.stderr === "string" ? cause.stderr : "";
  if (failure.command === "api graphql" && /HTTP 50[0234]/i.test(stderr)) return false;
  return /HTTP 50[0234]|connection reset|unexpected EOF|i\/o timeout|TLS handshake timeout/i.test(stderr);
};

const backoff = withBackoff<GhFailure>({ retryable: transientGh });
export const GITHUB_HEALTH_KEY = storeKey("health:github", Health);

// Response headers, unlike /rate_limit, describe the bucket that actually served this request.
const cooldownKey = (resource: string) =>
  storeKey(`github:cooldown:${resource}`, Schema.Struct({ until: Schema.Finite, reason: Schema.String }));
const Rate = Schema.Struct({
  data: Schema.NullOr(
    Schema.Struct({
      rateLimit: Schema.optional(
        Schema.Struct({
          cost: Schema.Finite,
          remaining: Schema.Finite,
          used: Schema.Finite,
          limit: Schema.Finite,
          resetAt: Schema.String,
        }),
      ),
    }),
  ),
});
const Envelope = Schema.StructWithRest(
  Schema.Struct({
    data: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const decodeRate = Schema.decodeOption(Schema.fromJsonString(Rate));
const missingFields = Schema.decodeOption(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Record(Schema.String, Schema.Unknown),
      errors: Schema.NonEmptyArray(Schema.Struct({ type: Schema.Literal("NOT_FOUND") })),
    }),
  ),
);

/** --include inserts a header block before each page, including inside a --slurp array. */
function response(stdout: string) {
  const headers: Record<string, string>[] = [];
  const body = stdout.replace(/\r\n/g, "\n").replace(/HTTP\/[\d.]+ [^\n]*\n(?:[^\n]+\n)*\n/g, (block) => {
    const page: Record<string, string> = {};
    for (const line of block.split("\n").slice(1)) {
      const colon = line.indexOf(":");
      if (colon >= 0) page[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
    }
    headers.push(page);
    return "";
  });
  return { body, headers };
}

/** The same client with an injectable process runner, so failed logins and recovery can be checked without GitHub. */
export const makeGh = (
  execute: (
    args: ReadonlyArray<string>,
    options: { signal: AbortSignal; maxBuffer: number },
  ) => Promise<{ stdout: string }>,
) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const record = (ok: boolean) =>
      Effect.gen(function* () {
        const before = yield* store.read(GITHUB_HEALTH_KEY);
        if (healthCurrent(before?.value, ok, yield* Clock.currentTimeMillis)) return;
        yield* store.write(GITHUB_HEALTH_KEY, { ok, at: DateTime.formatIso(yield* DateTime.now) });
      }).pipe(Effect.catch((failure) => Effect.logWarning("Could not record the GitHub health", failure)));
    return Gh.of({
      json: (args, schema, options) => {
        const command = args.slice(0, 2).join(" ");
        const graphql = args[1] === "graphql";
        const resource = graphql ? "graphql" : args[1]?.startsWith("search/") ? "search" : "core";
        const query = args.find((arg) => arg.startsWith("query="));
        const operation = query?.match(/query\s+(\w+)/)?.[1] ?? args[1]?.split("?")[0] ?? command;
        const included = [...args, "--include"].map((arg) =>
          graphql && arg.startsWith("query=") && !/\brateLimit\s*[{(]/.test(arg)
            ? arg.replace("{", "{ rateLimit { cost limit remaining used resetAt } ")
            : arg,
        );
        const observe = Effect.fnUntraced(function* (stdout: string, failed: boolean, stderr = "") {
          const parsed = response(stdout);
          const decoded = graphql ? decodeRate(parsed.body) : Option.none();
          const rate = Option.isSome(decoded) ? decoded.value.data?.rateLimit : undefined;
          // Pages are separate HTTP requests; log each REST page. GraphQL's cost covers the whole query.
          for (const header of parsed.headers.length ? parsed.headers : [{}]) {
            const bucket = header["x-ratelimit-resource"] ?? resource;
            const remaining = header["x-ratelimit-remaining"] ?? rate?.remaining;
            const reset = header["x-ratelimit-reset"]
              ? Number(header["x-ratelimit-reset"]) * 1000
              : rate
                ? Option.getOrUndefined(Option.map(DateTime.make(rate.resetAt), DateTime.toEpochMillis))
                : undefined;
            const now = yield* Clock.currentTimeMillis;
            const secondary = /secondary rate limit|abuse detection/i.test(stderr);
            const limited = /rate limit/i.test(stderr) || (remaining !== undefined && Number(remaining) === 0);
            // Leave 10% of the user's GraphQL budget for gh and other agents.
            const reserve = bucket === "graphql" && remaining !== undefined && Number(remaining) <= 500;
            if (secondary || limited || reserve) {
              const until = secondary
                ? now + Math.max(60, Number(header["retry-after"]) || 0) * 1000
                : reset !== undefined && Number.isFinite(reset) && reset > now
                  ? reset + 1000
                  : now + 60_000;
              yield* store
                .write(cooldownKey(secondary ? "all" : bucket), {
                  until,
                  reason: secondary
                    ? "secondary rate limit"
                    : reserve && !limited
                      ? "500 points reserved for other tools"
                      : "rate limit exhausted",
                })
                .pipe(Effect.catch((error) => Effect.logWarning("Could not record GitHub cooldown", error)));
            }
            yield* Effect.logInfo(
              "GitHub usage " +
                JSON.stringify({
                  operation,
                  resource: bucket,
                  cost: graphql ? (rate?.cost ?? null) : null,
                  remaining: remaining === undefined ? null : Number(remaining),
                  used:
                    header["x-ratelimit-used"] === undefined
                      ? (rate?.used ?? null)
                      : Number(header["x-ratelimit-used"]),
                  resetAt:
                    reset !== undefined && Number.isFinite(reset)
                      ? DateTime.formatIso(DateTime.makeUnsafe(reset))
                      : null,
                  failed,
                }),
            );
          }
          return parsed.body;
        });
        const attempt = Effect.gen(function* () {
          for (const bucket of ["all", resource]) {
            const cooldown = yield* store.read(cooldownKey(bucket)).pipe(Effect.orDie);
            const now = yield* Clock.currentTimeMillis;
            if (cooldown && cooldown.value.until > now)
              return yield* new GhFailure({
                command,
                cause: new Error(
                  `GitHub ${bucket} paused until ${DateTime.formatIso(DateTime.makeUnsafe(cooldown.value.until))}: ${cooldown.value.reason}`,
                ),
              });
          }
          const result = yield* Effect.tryPromise({
            try: (signal) => execute(included, { signal, maxBuffer: options?.maxBuffer ?? 8 * 1024 * 1024 }),
            catch: (cause) => new GhFailure({ command, cause }),
          }).pipe(
            Effect.tapError((failure) => {
              const cause = failure.cause;
              const stdout =
                cause instanceof Error && "stdout" in cause && typeof cause.stdout === "string" ? cause.stdout : "";
              const stderr =
                cause instanceof Error && "stderr" in cause && typeof cause.stderr === "string"
                  ? cause.stderr
                  : causeText(cause);
              return observe(stdout, true, stderr);
            }),
            Effect.catch((failure) => {
              const cause = failure.cause;
              const stdout =
                cause instanceof Error && "stdout" in cause && typeof cause.stdout === "string" ? cause.stdout : "";
              // Only explicitly requested, field-local NOT_FOUND errors may yield partial data.
              // Authentication, quota and transport errors retain the usual failure/backoff behavior.
              return graphql && options?.allowMissingFields && Option.isSome(missingFields(response(stdout).body))
                ? Effect.succeed({ stdout, partial: true })
                : Effect.fail(failure);
            }),
          );
          const body = "partial" in result ? response(result.stdout).body : yield* observe(result.stdout, false);
          if (!graphql || !query || /\brateLimit\s*[{(]/.test(query)) return body;
          // The caller may decode data as an alias dictionary (notifications). Instrumentation is not an alias.
          const envelope = yield* Schema.decodeEffect(Schema.fromJsonString(Envelope))(body).pipe(
            Effect.mapError((cause) => new GhFailure({ command, cause })),
          );
          if (!envelope.data) return body;
          const { rateLimit: _rateLimit, ...data } = envelope.data;
          return JSON.stringify({ ...envelope, data });
        });
        return attempt.pipe(
          backoff,
          Effect.flatMap((stdout) =>
            Schema.decodeEffect(Schema.fromJsonString(schema))(stdout).pipe(
              Effect.mapError((cause) => new GhFailure({ command, cause })),
            ),
          ),
          Effect.tap(() => record(true)),
          Effect.tapError(() => record(false)),
          withIoSpan("gh", { attributes: { command } }),
        );
      },
    });
  });

/** The GitHub CLI, signed in on the Mac. A call that runs past a minute is killed. */
export class Gh extends Context.Service<
  Gh,
  {
    /** Runs `gh` with `args` and decodes its JSON output with `schema`. */
    json<A>(
      args: ReadonlyArray<string>,
      schema: Schema.Codec<A, unknown>,
      options?: { readonly maxBuffer?: number; readonly allowMissingFields?: boolean },
    ): Effect.Effect<A, GhFailure>;
  }
>()("mondash/server/Gh") {
  static readonly layer = Layer.effect(
    Gh,
    Effect.gen(function* () {
      const gh = yield* makeGh((args, options) => run("gh", [...args], { ...options, timeout: 60_000 }));
      return Gh.of({
        json: (args, schema, options) =>
          Effect.gen(function* () {
            if (!enabled("github") && !(yield* ConnectionSetup))
              return yield* new GhFailure({ command: "setup", cause: new Error("GitHub is disconnected") });
            return yield* gh.json(args, schema, options);
          }),
      });
    }),
  );
}
