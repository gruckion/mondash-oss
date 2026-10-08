import { Cause, Clock, Duration, Effect, Schema } from "effect";
import { Store, storeKey } from "@/services/store";
import { type ActiveTicket, UnlinkedThread } from "./resume.ts";

/** Match a parent permalink and any reply permalink to the same Slack thread. */
export function slackThreadIdentity(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !/^[a-z0-9-]+\.slack\.com$/.test(url.hostname)) return undefined;
    const match = url.pathname.match(/^\/archives\/(\w+)\/p(\d{10})(\d{6})$/);
    if (!match) return undefined;
    const thread = url.searchParams.get("thread_ts") || `${match[2]}.${match[3]}`;
    return `${match[1]}:${thread}`;
  } catch {
    return undefined;
  }
}

/** Recheck cached discovery against today's attachments, even if a scan started before a link was saved. */
export function unattachedThreads(ticket: ActiveTicket, candidates: ReadonlyArray<UnlinkedThread>): UnlinkedThread[] {
  const attached = new Set(
    [...ticket.attachments, ...ticket.slack].map((item) => slackThreadIdentity(item.url)).filter(Boolean),
  );
  return candidates.filter((thread) => {
    const identity = slackThreadIdentity(thread.url);
    if (!identity || !thread.channel.startsWith("#") || attached.has(identity)) return false;
    attached.add(identity);
    return true;
  });
}

// Each rescan is one Slack search per active ticket, and it shares the per-user search quota with the Inbox.
const FRESH = Duration.hours(1);
const RETRY = Duration.seconds(30);
const ThreadEntries = Schema.Array(Schema.Tuple([Schema.String, Schema.Array(UnlinkedThread)]));
type ThreadEntries = typeof ThreadEntries.Type;
export type ThreadSnapshot = { entries: ThreadEntries; state: "loading" | "ready" | "error" };
const StoredThreads = Schema.Struct({ fingerprint: Schema.String, entries: ThreadEntries });
// Arrays, not a Map, so the candidates survive the store's JSON.
export const THREADS_KEY = storeKey("slack-threads:v1", StoredThreads);

/** Attachments are part of the identity: a pre-link scan cannot be reused after that ticket changes. */
function fingerprint(tickets: ReadonlyArray<ActiveTicket>): string {
  return JSON.stringify(
    tickets
      .map((ticket) => [
        ticket.id,
        [...ticket.attachments, ...ticket.slack]
          .map((attachment) => slackThreadIdentity(attachment.url))
          .filter(Boolean)
          .sort(),
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}

/**
 * Slack threads that name your tickets but are not linked to them. `refresh` (the sections' refresh) starts a scan in
 * the background when the stored one is for other tickets or an hour old; `snapshot` (every read) only reads the
 * store and says whether a scan is running or failed.
 */
export const makeThreadDiscovery = <E, R>(
  find: (tickets: ReadonlyArray<ActiveTicket>) => Effect.Effect<Map<string, UnlinkedThread[]>, E, R>,
) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const scope = yield* Effect.scope;
    const running = new Set<string>();
    const failures = new Map<string, number>();
    let latest = "";
    const stored = (key: string) =>
      store.read(THREADS_KEY).pipe(Effect.map((found) => (found?.value.fingerprint === key ? found : undefined)));

    const snapshot = (tickets: ReadonlyArray<ActiveTicket>) =>
      Effect.gen(function* () {
        if (tickets.length === 0) return { entries: [], state: "ready" } satisfies ThreadSnapshot;
        const key = fingerprint(tickets);
        const matching = yield* stored(key);
        const entries = matching ? matching.value.entries : [];
        const state = running.has(key) ? "loading" : failures.has(key) ? "error" : matching ? "ready" : "loading";
        return { entries, state } satisfies ThreadSnapshot;
      });

    const refresh = (tickets: ReadonlyArray<ActiveTicket>) =>
      Effect.gen(function* () {
        const key = tickets.length === 0 ? "" : fingerprint(tickets);
        latest = key;
        if (tickets.length === 0 || running.has(key)) return;
        const now = yield* Clock.currentTimeMillis;
        const matching = yield* stored(key);
        if (matching && now - matching.at.getTime() < Duration.toMillis(FRESH)) return;
        const failedAt = failures.get(key);
        if (failedAt !== undefined && now - failedAt < Duration.toMillis(RETRY)) return;
        running.add(key);
        yield* find(tickets).pipe(
          Effect.flatMap((found) =>
            // An older scan finishing later must not overwrite the current ticket and attachment snapshot.
            latest === key ? store.write(THREADS_KEY, { fingerprint: key, entries: [...found] }) : Effect.void,
          ),
          Effect.andThen(Effect.sync(() => failures.delete(key))),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.gen(function* () {
                  failures.set(key, yield* Clock.currentTimeMillis);
                  yield* Effect.logWarning("Slack thread discovery failed", cause);
                }),
          ),
          Effect.ensuring(Effect.sync(() => running.delete(key))),
          Effect.withSpan("threads.discover", { attributes: { tickets: tickets.length } }),
          Effect.forkIn(scope),
        );
      });

    return { snapshot, refresh };
  });
