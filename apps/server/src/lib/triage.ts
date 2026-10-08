import { selfName, selfFirstName } from "./people";
import { createHash } from "node:crypto";
import { DateTime, Duration, Effect, Result, Schema } from "effect";
import { noul } from "@/lib/jev";
import { ticketIds } from "@/lib/slack";
import { getMine, issuesById, LinearIssue } from "@/lib/linear-api";
import { Mcp } from "@/services/mcp";
import { Store, storeKey } from "@/services/store";

export type Ticket = typeof LinearIssue.Type;

export { LinearIssue };

const CLOSED = new Set(["completed", "canceled", "duplicate"]);

const Verdict = {
  /** The saved message's link, which the Inbox matches its saved items by. */
  permalink: Schema.String,
  tickets: Schema.Array(Schema.Struct({ ...LinearIssue.fields, mine: Schema.Boolean })),
};

/** Whether a message you saved in Slack still needs you, and why not when it does not. */
export const TriageItem = Schema.Union([
  Schema.Struct({ ...Verdict, show: Schema.Literal(true), needsYou: Schema.optional(Schema.Finite) }),
  Schema.Struct({ ...Verdict, show: Schema.Literal(false), reason: Schema.String }),
]);
export type TriageItem = typeof TriageItem.Type;

const decodeSlackThread = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ messages: Schema.String })));

const NEEDS_YOU_THRESHOLD = 0.5;

/** Jev's verdict for one saved thread, kept a day per thread text: a thread nobody adds to keeps its answer. */
export const needsYouKey = (permalink: string, thread: string) =>
  storeKey(
    `jev-triage:v1:${permalink}:${createHash("sha256").update(thread).digest("hex").slice(0, 16)}`,
    Schema.Finite,
  );

/** Jev's chance that a saved thread still needs you, or undefined when Jev could not answer. */
export const needsYouChance = (permalink: string, thread: string, today: string) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const text = thread.slice(0, 6000);
    // ponytail: user name is hard-coded; read it from slack_read_user_profile if others use this app.
    return yield* store.cached(
      needsYouKey(permalink, text),
      Duration.days(1),
      noul(
        { user: `${selfName}`, saved_slack_thread: text, today },
        {
          true: "The user still has an open action on this saved thread: an unanswered question, a request, or work nobody has picked up.",
          false:
            "Nothing is left for the user: the thread is resolved, answered, or it is only an announcement or FYI.",
        },
      ),
    );
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(`Jev could not judge saved item ${permalink}; showing it.`, error).pipe(Effect.as(undefined)),
    ),
  );

export const TRIAGE_KEY = storeKey("triage:v2", Schema.Array(TriageItem));
// Saved items change hourly (the saved search) and their verdicts are cached a day; this is for their tickets.
export const TRIAGE_FRESH = Duration.minutes(5);

/** A message you saved, as the Inbox's saved search stores it. */
export type SavedMessage = {
  readonly url: string;
  readonly snippet?: string;
  readonly slack?: { readonly channel: string; readonly ts: string; readonly threadTs?: string };
};

/** The verdict on each saved message. Saved messages in one thread share the thread's verdict. */
export const buildTriage = (saved: ReadonlyArray<SavedMessage>) =>
  Effect.gen(function* () {
    const mcp = yield* Mcp;
    const store = yield* Store;
    const threads = Map.groupBy(
      saved.flatMap((message) => (message.slack ? [{ ...message, slack: message.slack }] : [])),
      (message) => `${message.slack.channel}:${message.slack.threadTs ?? message.slack.ts}`,
    );
    // Up to 3 at once to stay under Slack rate limits; cached, because a thread's ticket links rarely change.
    const read = yield* Effect.forEach(
      threads.values(),
      (messages) =>
        Effect.gen(function* () {
          const sorted = messages.toSorted((a, b) => Number(a.slack.ts) - Number(b.slack.ts));
          const { channel, ts, threadTs } = sorted[0].slack;
          const thread = yield* mcp
            .cachedCall("slack", "slack_read_thread", { channel_id: channel, message_ts: threadTs ?? ts }, "5 minutes")
            .pipe(
              Effect.flatMap(decodeSlackThread),
              Effect.map((t) => t.messages),
              Effect.catch((error) =>
                Effect.logWarning(
                  `Could not read Slack thread ${channel}/${threadTs ?? ts}; using the saved messages only.`,
                  error,
                ).pipe(Effect.as(sorted.flatMap((m) => (m.snippet ? [m.snippet] : [])).join("\n"))),
              ),
            );
          return { permalinks: sorted.map((m) => m.url), thread };
        }),
      { concurrency: 3 },
    );

    const me = (yield* getMine).me.id;
    const before = new Map(((yield* store.read(TRIAGE_KEY))?.value ?? []).map((item) => [item.permalink, item]));
    const today = DateTime.formatIso(yield* DateTime.now).slice(0, 10);
    const found = yield* issuesById(read.flatMap(({ thread }) => ticketIds(thread))).pipe(Effect.result);
    if (Result.isFailure(found))
      yield* Effect.logWarning("Could not read the tickets on saved items; keeping their last state.", found.failure);
    const verdicts = yield* Effect.forEach(
      read,
      ({ permalinks: [permalink, ...others], thread }) =>
        Effect.gen(function* () {
          // Linear down is not "no ticket": a closed ticket would otherwise surface the item, or Jev would judge it.
          if (Result.isFailure(found)) {
            const kept = before.get(permalink);
            return kept ? kept : ({ permalink, tickets: [], show: true } satisfies TriageItem);
          }
          const tickets = ticketIds(thread).flatMap((id) => {
            const ticket = found.success.get(id);
            return ticket ? [{ ...ticket, mine: ticket.assigneeId === me }] : [];
          });
          // A saved item with an open ticket stays visible: the ticket shows its status, Jev is not needed.
          if (tickets.some((t) => !CLOSED.has(t.statusType)))
            return { permalink, tickets, show: true } satisfies TriageItem;
          if (tickets.length)
            return {
              permalink,
              tickets,
              show: false,
              reason: `Linked ${tickets.map((t) => t.id).join(", ")} is closed`,
            } satisfies TriageItem;

          const needsYou = yield* needsYouChance(permalink, thread, today);
          if (needsYou === undefined) return { permalink, tickets, show: true } satisfies TriageItem;
          return needsYou >= NEEDS_YOU_THRESHOLD
            ? ({ permalink, tickets, show: true, needsYou } satisfies TriageItem)
            : ({
                permalink,
                tickets,
                show: false,
                reason: `Jev: ${Math.round(needsYou * 100)}% chance it still needs you`,
              } satisfies TriageItem);
        }).pipe(Effect.map((verdict) => [verdict, ...others.map((other) => ({ ...verdict, permalink: other }))])),
      { concurrency: 3 },
    );
    return verdicts.flat();
  });
