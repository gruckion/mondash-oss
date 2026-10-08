import { enabled } from "./profile";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Cause, Duration, Effect, Layer, Option, Queue, Redacted, Schedule, Schema, type Scope, Stream } from "effect";
import { ServerConfig } from "@/config";
import { getMyOpenPRs, probeGitHub, PRS_KEY } from "@/lib/github";
import { fetchMine, MINE_KEY } from "@/lib/linear-api";
import { rebuildReview } from "@/lib/github-feed";
import { rebuildRoadmap } from "@/lib/notion";
import { rebuildResume } from "@/lib/resume";
import { rebuildRecentSessions } from "@/lib/sessions";
import { Dashboard } from "@/services/dashboard";
import {
  addSlackMessage,
  addSlackThreadOfMine,
  rebuildTriage,
  refreshSlackSearches,
  SLACK_ME,
  slackThreadsOfMine,
} from "@/lib/feed";
import { inboxKind, type MessageEvent, messageEvent } from "@/lib/slack-events";
import { Inbox } from "@/services/inbox";
import { ForceRefresh, Store, storeKey } from "@/services/store";

/**
 * What makes the dashboard live. Slack pushes over a websocket (Socket Mode, no public URL). GitHub and Linear have no
 * push without one, so a light check asks "did anything change?" and the full rebuild only runs when it did. The
 * sections (Notion's Roadmap among them) and the Saved-in-Slack verdicts refresh here each minute while someone looks,
 * every 15 minutes otherwise; the Inbox fetches GitHub and Linear notifications and rebuilds each minute, reading the
 * other sections as stored. The app's requests only read what is stored. Everything here stops when the server stops.
 */

type Source = "github" | "linear";

/** Slack Socket Mode did not open, or the connection dropped. */
class SlackSocketFailure extends Schema.TaggedError<SlackSocketFailure>()("SlackSocketFailure", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
  /** Slack refused the token: retrying cannot help until it is replaced. */
  fatal: Schema.optional(Schema.Boolean),
}) {}

/** Slack's `apps.connections.open` errors that only a new token fixes. */
const TOKEN_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "not_allowed_token_type",
]);

const hash = (value: unknown) => createHash("sha1").update(JSON.stringify(value)).digest("hex");

/**
 * A source moved, so the sections that use it are rebuilt in the background. The rebuilds are forced: a build that
 * started before the move would store the old data with a new time.
 */
export const rebuild = (source: Source) => {
  // Each section keeps its last good copy when its rebuild fails, so one failure must not stop the others.
  const logged = <A, E, R>(build: Effect.Effect<A, E, R>) =>
    build.pipe(
      Effect.asVoid,
      Effect.catchCause((cause) => Effect.logWarning(`A ${source} rebuild failed`, cause)),
    );
  const resume = enabled("linear") || enabled("github") ? logged(rebuildResume) : Effect.void;
  const sections =
    source === "github"
      ? [resume, enabled("github") ? logged(rebuildReview) : Effect.void]
      : [
          resume,
          enabled("notion") ? logged(rebuildRoadmap) : Effect.void,
          enabled("slack") ? logged(rebuildTriage) : Effect.void,
        ];
  return Effect.all(sections, { concurrency: "unbounded", discard: true }).pipe(
    Effect.provideService(ForceRefresh, true),
    Effect.withSpan("live.rebuild", { attributes: { source } }),
  );
};

/**
 * Runs `check` now and then every `every`. When its answer differs from last time, `onChange` runs. The first run
 * ever only records where things stand. A failed or hung check is logged and retried on the next tick.
 */
export const watch = <E1, R1, E2, R2>(
  source: Source,
  every: Duration.Input,
  check: Effect.Effect<unknown, E1, R1>,
  onChange: Effect.Effect<void, E2, R2>,
) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const key = storeKey(`live:${source}`, Schema.String);
    const now = hash(yield* check.pipe(Effect.timeout("2 minutes")));
    const before = yield* store.read(key);
    if (before?.value === now) return;
    yield* store.write(key, now);
    if (before) yield* onChange;
  }).pipe(
    Effect.withSpan("live.check", { attributes: { source } }),
    Effect.catchCause((cause) => Effect.logWarning(`Live check for ${source} failed`, cause)),
    Effect.repeat(Schedule.spaced(every)),
  );

/** Slack's answer to `apps.connections.open`. The app opens the socket, so no public URL is needed. */
const ConnectionsOpen = Schema.Struct({
  ok: Schema.Boolean,
  url: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});

/**
 * "connected" when the socket opens, then each new message Slack pushes (other events are acknowledged and dropped).
 * The stream ends when Slack closes a socket that opened, and fails when the socket could not open.
 */
const slackMessages = (token: Redacted.Redacted) =>
  Stream.callback<"connected" | MessageEvent, SlackSocketFailure>((queue) =>
    Effect.gen(function* () {
      const opened = yield* Effect.tryPromise({
        try: async (signal) => {
          const response = await fetch("https://slack.com/api/apps.connections.open", {
            method: "POST",
            headers: { Authorization: `Bearer ${Redacted.value(token)}` },
            signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          });
          const json: unknown = await response.json();
          return json;
        },
        catch: (cause) => new SlackSocketFailure({ reason: "Socket Mode did not open", cause }),
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ConnectionsOpen)),
        Effect.mapError((cause) => new SlackSocketFailure({ reason: "Socket Mode did not open", cause })),
      );
      const url = opened.url;
      if (!opened.ok || !url) {
        const error = opened.error ?? "no socket URL";
        return yield* new SlackSocketFailure({
          reason: `Slack refused Socket Mode: ${error}`,
          fatal: TOKEN_ERRORS.has(error),
        });
      }
      const socket = yield* Effect.acquireRelease(
        Effect.try({
          try: () => new WebSocket(url),
          catch: (cause) => new SlackSocketFailure({ reason: "Could not open the socket", cause }),
        }),
        (ws) => Effect.sync(() => ws.close()),
      );
      const context = yield* Effect.context<never>();
      let connected = false;
      socket.addEventListener("open", () => {
        connected = true;
        Effect.runForkWith(context)(Effect.logInfo("Slack Socket Mode connected: DMs arrive live"));
        Queue.offerUnsafe(queue, "connected");
      });
      socket.addEventListener("message", (event) => {
        const text = String(event.data);
        // Slack wants every envelope acknowledged, or it sends it again.
        const envelope = Schema.decodeOption(
          Schema.fromJsonString(Schema.Struct({ envelope_id: Schema.optional(Schema.String) })),
        )(text);
        if (Option.isSome(envelope) && envelope.value.envelope_id)
          socket.send(JSON.stringify({ envelope_id: envelope.value.envelope_id }));
        const message = messageEvent(text);
        if (message) Queue.offerUnsafe(queue, message);
      });
      // Slack cycles the connection every so often, and closes it during its own deploys.
      socket.addEventListener("close", () => {
        if (connected) Queue.endUnsafe(queue);
        else Queue.failCauseUnsafe(queue, Cause.fail(new SlackSocketFailure({ reason: "Slack closed the socket" })));
      });
    }),
  );

/**
 * Runs `effect` in `scope`, `delay` after the first call. Calls made before it starts join that run, so a burst runs
 * it once.
 */
export const coalesced = <R>(effect: Effect.Effect<void, never, R>, delay: Duration.Input, scope: Scope.Scope) => {
  let pending = false;
  return Effect.suspend(() => {
    if (pending) return Effect.void;
    pending = true;
    return Effect.sleep(delay).pipe(
      Effect.andThen(Effect.sync(() => void (pending = false))),
      Effect.andThen(effect),
      Effect.forkIn(scope),
      Effect.asVoid,
    );
  });
};

/**
 * On connect, the searches catch up on what came while the socket was down. After that, a DM, a mention of you or a
 * reply in one of your threads goes into the Inbox at once, and its phone alert about 2 s later, so a burst of
 * messages gives one alert summary. Your own messages mark their thread as yours; any other message is dropped.
 */
const onSlackMessage =
  (myThreads: Set<string>, refreshSoon: Effect.Effect<void>) => (item: "connected" | MessageEvent) =>
    Effect.gen(function* () {
      const inbox = yield* Inbox;
      if (item === "connected") {
        for (const thread of yield* slackThreadsOfMine) myThreads.add(thread);
        yield* refreshSlackSearches;
        return yield* inbox.refreshAndNotify;
      }
      if (item.user === SLACK_ME) {
        const thread = item.thread_ts ?? item.ts;
        myThreads.add(thread);
        return yield* addSlackThreadOfMine(thread);
      }
      const kind = inboxKind(item, SLACK_ME, myThreads);
      if (!kind) return;
      yield* addSlackMessage(item, kind);
      yield* Effect.logInfo(`Slack ${kind} arrived over the socket`);
      yield* refreshSoon;
    }).pipe(
      Effect.withSpan("live.slack.message"),
      Effect.catchCause((cause) => Effect.logWarning("Slack message failed", cause)),
    );

/**
 * The websocket. A connection that opened and then closed is opened again after 2 seconds; one that fails to open is
 * retried with backoff (2 s, doubling, at most a minute apart).
 */
const slackSocket = (token: Redacted.Redacted) =>
  Effect.gen(function* () {
    const inbox = yield* Inbox;
    const refreshSoon = coalesced(
      inbox.refreshAndNotify.pipe(Effect.catchCause((cause) => Effect.logWarning("Inbox refresh failed", cause))),
      "2 seconds",
      yield* Effect.scope,
    );
    yield* slackMessages(token).pipe(
      Stream.runForEach(onSlackMessage(new Set(), refreshSoon)),
      Effect.catchDefect((cause) => Effect.fail(new SlackSocketFailure({ reason: "Unexpected error", cause }))),
      Effect.tapError((failure) =>
        Effect.logWarning(
          `Slack Socket Mode: ${failure.reason}${failure.fatal ? "" : "; reconnecting"}`,
          failure.cause,
        ),
      ),
      Effect.retry({
        schedule: Schedule.min([Schedule.exponential("2 seconds"), Schedule.spaced("1 minute")]),
        while: (failure) => !failure.fatal,
      }),
      Effect.tap(() => Effect.logInfo("Slack Socket Mode: Slack closed the socket; reconnecting")),
      Effect.repeat(Schedule.spaced("2 seconds")),
      Effect.catch((failure) =>
        Effect.logError(`Slack Socket Mode stopped: ${failure.reason}. Replace SLACK_APP_TOKEN.`),
      ),
    );
  });

/**
 * Store rows nothing reads any more, deleted when older than the age. Jev answers are keyed per item and never
 * overwritten, so they pile up.
 */
const PRUNE: ReadonlyArray<readonly [prefix: string, age: Duration.Input]> = [
  ["jev-session-choice:", Duration.zero],
  ["jev-session-item:v1:", Duration.zero],
  ["jev-session-item:v2:", Duration.zero],
  ["jev-dm:", Duration.days(14)],
  ["jev-debrief:", Duration.days(14)],
  ["jev-debrief-topic:", Duration.days(14)],
  ["jev-debrief-topic-urgency:", Duration.days(14)],
  ["jev-debrief-urgency:", Duration.days(14)],
  ["debrief:search:", Duration.days(31)],
  ["debrief:pr:", Duration.days(14)],
  ["jev-session-item:", Duration.days(14)],
  ["jev-triage:", Duration.days(14)],
  ["jev-card-ticket:", Duration.days(14)],
  ["session-search:", Duration.days(1)],
  ["mcp:linear:", Duration.zero],
  ["live:notion", Duration.zero],
  ["resume:mobile-threads:", Duration.zero],
  // Reparse Claude transcripts with generated summaries separated from typed prompts (v3).
  [`session-file:v1:${join(homedir(), ".claude")}`, Duration.zero],
  [`session-file:v2:${join(homedir(), ".claude")}`, Duration.zero],
  ["sessions:recent:v3", Duration.zero],
  ["live:sessions", Duration.zero],
];

/** Deletes the `PRUNE` rows and logs how many went. */
export const pruneStore = Effect.gen(function* () {
  const store = yield* Store;
  const removed = yield* Effect.forEach(PRUNE, ([prefix, age]) => store.prune(prefix, age));
  const total = removed.reduce((sum, count) => sum + count, 0);
  yield* Effect.logInfo(`Store pruned: ${total} old rows removed`);
  return total;
}).pipe(Effect.withSpan("live.prune"));

/** Starts the websocket and the checks with the server; they stop when it stops. */
export const LiveLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const store = yield* Store;
    const inbox = yield* Inbox;
    const dashboard = yield* Dashboard;

    if (enabled("slack") && Option.isSome(config.slackAppToken))
      yield* Effect.forkScoped(slackSocket(config.slackAppToken.value));
    else yield* Effect.logInfo("SLACK_APP_TOKEN is not set: Slack refreshes on a timer only");

    // Inbox: its alert sources fetched and the feed rebuilt every minute, and anything new becomes a phone alert.
    yield* Effect.forkScoped(
      inbox.refreshAndNotify.pipe(
        Effect.catchCause((cause) => Effect.logWarning("Inbox refresh failed", cause)),
        Effect.repeat(Schedule.spaced("1 minute")),
      ),
    );

    // Sections: refreshed here, never by the app's requests (they only read the store), so a screen left open does not
    // multiply provider calls.
    yield* Effect.forkScoped(dashboard.warm.pipe(Effect.repeat(Schedule.spaced("1 minute"))));

    // GitHub: check every three minutes. Busy repositories otherwise force expensive full rebuilds each minute.
    // The full PR and review queries run only when it moved. What the probe cannot
    // see, such as a resolved thread, waits for the sections' own refresh.
    if (enabled("github"))
      yield* Effect.forkScoped(
        watch(
          "github",
          "3 minutes",
          probeGitHub(),
          store.refresh(PRS_KEY, getMyOpenPRs(), { force: true }).pipe(Effect.andThen(rebuild("github"))),
        ),
      );
    // Linear: one query a minute for your open issues, comments included; a change rebuilds what shows them.
    if (enabled("linear"))
      yield* Effect.forkScoped(
        watch(
          "linear",
          "1 minute",
          store
            .refresh(MINE_KEY, fetchMine)
            .pipe(Effect.map((mine) => mine.issues.map((i) => [i.id, i.updatedAt, i.comments.length]))),
          rebuild("linear"),
        ),
      );
    yield* Effect.forkScoped(
      pruneStore.pipe(
        Effect.catchCause((cause) => Effect.logWarning("Store prune failed", cause)),
        Effect.repeat(Schedule.spaced("1 day")),
      ),
    );
    // Agent sessions: local files, read again every 30 s for the Sessions tab. The cards that list sessions pick a new
    // one up on the next section refresh, without refetching Linear and Notion.
    if (enabled("sessions"))
      yield* Effect.forkScoped(
        rebuildRecentSessions().pipe(
          Effect.catchCause((cause) => Effect.logWarning("Reading the agent sessions failed", cause)),
          Effect.repeat(Schedule.spaced("30 seconds")),
        ),
      );
  }),
);
