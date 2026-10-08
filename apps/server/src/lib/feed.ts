import { identityDirectory, profile, enabled } from "../profile";
import { Clock, DateTime, Duration, Effect, Option, Schema, Struct } from "effect";
import { CalendarEvent } from "@mondash/shared/contract";
import { ROADMAP_FRESH, ROADMAP_KEY } from "@/lib/notion";
import { buildTriage, LinearIssue, TRIAGE_FRESH, TRIAGE_KEY } from "@/lib/triage";
import { ME, person } from "@/lib/people";
import { plain } from "@/lib/slack";
import { type MessageEvent, permalink } from "@/lib/slack-events";
import { channelName, myWorkspace, slackMessage, userName } from "@/lib/slack-web";
import { slackMessagePreview } from "./slack-message";
import { isRead, justBefore, Override } from "@/lib/feed-tabs";
import { notify } from "@/lib/ntfy";
import { Gh } from "@/services/gh";
import { Mcp } from "@/services/mcp";
import { fetchNotifications, NOTIFICATIONS_KEY } from "@/lib/linear-api";
import { SlackApi, SlackFailure } from "@/services/slack";
import { Store, storeKey } from "@/services/store";

/**
 * The Inbox: things meant for you from GitHub, Linear, Slack and Notion, newest first.
 * Research and the noise rules behind each source: experiments/notification-feed/PLAN.md.
 */
export const FeedItem = Schema.Struct({
  id: Schema.String,
  source: Schema.Literals(["github", "linear", "slack", "notion"]),
  kind: Schema.String,
  title: Schema.String,
  snippet: Schema.optional(Schema.String),
  links: Schema.optional(Schema.Array(Schema.Struct({ title: Schema.String, url: Schema.String }))),
  calendarEvent: Schema.optional(CalendarEvent),
  /** Any key people() understands: GitHub login, email, Slack ID or full name. */
  actor: Schema.optional(Schema.String),
  url: Schema.String,
  at: Schema.Date,
  reason: Schema.String,
  /** Worth a push. Saved Slack items, merges and status changes are listed quietly. */
  push: Schema.Boolean,
  /** The source's own read state, where it has one (GitHub, Linear, Slack). */
  read: Schema.optional(Schema.Boolean),
  /** Where the message sits in Slack, for reading and moving its read marker. */
  slack: Schema.optional(
    Schema.Struct({ channel: Schema.String, ts: Schema.String, threadTs: Schema.optional(Schema.String) }),
  ),
  /** Saved items: Jev's chance it still needs you, or why it is done (its tickets closed, or Jev says so). */
  needsYou: Schema.optional(Schema.Finite),
  done: Schema.optional(Schema.String),
  /** Saved items: the Linear tickets the message names, as the Saved-in-Slack verdict read them. */
  tickets: Schema.optional(
    Schema.Array(
      Schema.Struct({
        ...Struct.pick(LinearIssue.fields, ["id", "status", "statusType", "priority", "url"]),
        mine: Schema.Boolean,
      }),
    ),
  ),
});
export type FeedItem = typeof FeedItem.Type;
const FeedItems = Schema.Array(FeedItem);

export const FEED_KEY = storeKey("feed:v1", FeedItems);
const DAY = 24 * 60 * 60 * 1000;
const WINDOW = 14 * DAY;
const recent = (at: Date, now: number) => now - at.getTime() < WINDOW;
const clip = (text: string, n = 220) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

// GitHub ---------------------------------------------------------------------------------------------

export const MY_LOGIN = person(ME)?.github ?? "";
const Thread = Schema.Struct({
  id: Schema.String,
  unread: Schema.Boolean,
  reason: Schema.String,
  updated_at: Schema.String,
  subject: Schema.Struct({ title: Schema.String, type: Schema.String, url: Schema.NullOr(Schema.String) }),
  repository: Schema.Struct({ full_name: Schema.String, owner: Schema.Struct({ login: Schema.String }) }),
});
const Actor = Schema.NullOr(Schema.Struct({ __typename: Schema.optional(Schema.String), login: Schema.String }));
const Event = Schema.Struct({
  __typename: Schema.String,
  createdAt: Schema.String,
  url: Schema.optional(Schema.String),
  bodyText: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  author: Schema.optional(Actor),
  actor: Schema.optional(Actor),
  requestedReviewer: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.optional(Schema.String) }))),
});
const Hydrated = Schema.Struct({
  data: Schema.Record(
    Schema.String,
    Schema.NullOr(
      Schema.Struct({
        pullRequest: Schema.NullOr(
          Schema.Struct({
            url: Schema.String,
            author: Actor,
            timelineItems: Schema.Struct({ nodes: Schema.Array(Event) }),
          }),
        ),
      }),
    ),
  ),
});

// One persisted timeline snapshot. Read flags and titles still come from each fresh REST response.
const GITHUB_EVENTS_KEY = storeKey(
  "github:notification-events:v2",
  Schema.Struct({
    fingerprint: Schema.String,
    data: Hydrated.fields.data,
  }),
);

// "Why you are subscribed" reasons worth reading. ci_activity, subscribed and state_change are noise.
const GITHUB_REASONS = new Set(["review_requested", "mention", "team_mention", "comment", "author", "assign"]);
const BOT_LOGINS = new Set(["coderabbitai", "greptile-apps", "linear-code", "vercel", "github-actions", "linear"]);

/** GitHub says why you follow a PR, not what happened; the PR's newest event by someone else says that. */
const github = Effect.gen(function* () {
  const gh = yield* Gh;
  const now = yield* Clock.currentTimeMillis;
  const threads = (yield* gh.json(
    ["api", "notifications?all=true&participating=true&per_page=50"],
    Schema.Array(Thread),
  ))
    .filter(
      (t) =>
        (profile.workspace.githubPersonalOnly
          ? t.repository.owner.login.toLowerCase() === identityDirectory(profile.directory).self?.github?.toLowerCase()
          : !profile.workspace.organizations.length ||
            profile.workspace.organizations.some(
              (org) => org.toLowerCase() === t.repository.owner.login.toLowerCase(),
            )) &&
        GITHUB_REASONS.has(t.reason) &&
        t.subject.type === "PullRequest" &&
        recent(new Date(t.updated_at), now),
    )
    .slice(0, 25);
  const prs = threads.flatMap((t) => {
    const m = t.subject.url?.match(/repos\/([\w.-]+)\/([\w.-]+)\/pulls\/(\d+)$/);
    return m ? [{ thread: t, owner: m[1], repo: m[2], number: Number(m[3]) }] : [];
  });
  if (!prs.length) return [];
  const fields = `pullRequest(number: NUMBER) { url author { login } timelineItems(last: 6, itemTypes: [ISSUE_COMMENT, PULL_REQUEST_REVIEW, REVIEW_REQUESTED_EVENT, MERGED_EVENT]) { nodes {
    __typename
    ... on IssueComment { createdAt url bodyText author { __typename login } }
    ... on PullRequestReview { createdAt url bodyText state author { __typename login } }
    ... on ReviewRequestedEvent { createdAt actor { __typename login } requestedReviewer { ... on User { login } } }
    ... on MergedEvent { createdAt url actor { __typename login } }
  } } }`;
  const query = `query MondashNotificationEvents { ${prs.map((p, i) => `p${i}: repository(owner: "${p.owner}", name: "${p.repo}") { ${fields.replace("NUMBER", String(p.number))} }`).join("\n")} }`;
  const store = yield* Store;
  const fingerprint = JSON.stringify(prs.map((p) => [p.owner, p.repo, p.number, p.thread.updated_at]));
  const previous = yield* store.read(GITHUB_EVENTS_KEY);
  let data: typeof Hydrated.Type.data;
  if (previous?.value.fingerprint === fingerprint) data = previous.value.data;
  else {
    data = (yield* gh.json(["api", "graphql", "-f", `query=${query}`], Hydrated)).data;
    yield* store.write(GITHUB_EVENTS_KEY, { fingerprint, data });
  }
  return prs.flatMap((p, i): FeedItem[] => {
    const pr = data[`p${i}`]?.pullRequest;
    if (!pr) return [];
    const who = (e: typeof Event.Type) => e.author ?? e.actor;
    const theirs = pr.timelineItems.nodes.filter((e) => {
      const actor = who(e);
      if (!actor || actor.login === MY_LOGIN || actor.__typename === "Bot" || BOT_LOGINS.has(actor.login)) return false;
      return e.__typename !== "ReviewRequestedEvent" || e.requestedReviewer?.login === MY_LOGIN;
    });
    const event = theirs.at(-1);
    // Someone else merging a PR you only reviewed is not news; your own PR being merged is.
    if (
      !event ||
      !recent(new Date(event.createdAt), now) ||
      (event.__typename === "MergedEvent" && p.thread.reason !== "author")
    )
      return [];
    const kind =
      event.__typename === "IssueComment"
        ? "comment"
        : event.__typename === "PullRequestReview"
          ? event.state === "APPROVED"
            ? "approved"
            : event.state === "CHANGES_REQUESTED"
              ? "changes_requested"
              : "review"
          : event.__typename === "ReviewRequestedEvent"
            ? "review_requested"
            : "merged";
    const reason = {
      comment: "commented",
      approved:
        MY_LOGIN && pr.author?.login.toLowerCase() === MY_LOGIN.toLowerCase() ? "approved your PR" : "approved PR",
      changes_requested: "asked for changes",
      review: "reviewed",
      review_requested: "requested your review",
      merged: "merged",
    }[kind];
    const key = `${p.repo}#${p.number}`;
    return [
      {
        id: `github:${key}:${event.__typename}:${event.createdAt}`,
        source: "github",
        kind,
        title: `${key} ${p.thread.subject.title}`,
        snippet: event.bodyText ? clip(event.bodyText) : undefined,
        actor: who(event)?.login,
        url: event.url ?? pr.url,
        at: new Date(event.createdAt),
        reason,
        push: kind !== "merged",
        read: !p.thread.unread,
      },
    ];
  });
});

// Linear ---------------------------------------------------------------------------------------------

/** Linear's inbox, minus its copies of GitHub PR events (GitHub is the source for those) and reactions. */
const linear = Effect.gen(function* () {
  const rows = yield* (yield* Store).cached(NOTIFICATIONS_KEY, Duration.infinity, fetchNotifications);
  const now = yield* Clock.currentTimeMillis;
  return rows.flatMap((n): FeedItem[] => {
    if (
      n.category === "reviews" ||
      ["workspaceWelcome", "issueCommentReaction"].includes(n.type) ||
      !recent(new Date(n.createdAt), now)
    )
      return [];
    // Linear sends no subtitle for some notification types; the matches below then find nothing.
    const subtitle = n.subtitle === null || n.subtitle === undefined ? "" : n.subtitle;
    // "Casey Miller mentioned you: …", "morgan@example.com commented: …", "Assigned by Renée Frost"
    const said = subtitle.match(/^(.+?) (?:mentioned you|commented|replied)[^:]*: ([\s\S]*)$/);
    const by = subtitle.match(/ by (.+)$/)?.[1];
    const ticket = n.url.match(/\/issue\/([A-Z]+-\d+)/)?.[1];
    const reasons: Record<string, string> = {
      issueAssignedToYou: "assigned you",
      issueCommentMention: "mentioned you",
      issueMention: "mentioned you",
      issueNewComment: "commented",
      issueStatusChanged: subtitle,
    };
    return [
      {
        id: `linear:${n.id}`,
        source: "linear",
        kind: n.type,
        title: ticket ? `${ticket} ${n.title}` : n.title,
        snippet: said ? clip(said[2]) : undefined,
        actor: said?.[1] ?? by,
        url: n.url,
        at: new Date(n.createdAt),
        reason: reasons[n.type] ?? subtitle,
        push: n.type !== "issueStatusChanged",
        read: Boolean(n.readAt),
      },
    ];
  });
});

const orNothing = <E, R>(name: string, load: Effect.Effect<ReadonlyArray<FeedItem>, E, R>) =>
  load.pipe(
    Effect.catch((error) =>
      Effect.logWarning(`Inbox: could not read ${name}.`, error).pipe(Effect.as<ReadonlyArray<FeedItem>>([])),
    ),
  );

// Slack ----------------------------------------------------------------------------------------------

const SlackHit = Schema.Struct({
  channel_id: Schema.String,
  channel_name: Schema.optional(Schema.String),
  message_ts: Schema.String,
  content: Schema.String,
  author_user_id: Schema.optional(Schema.String),
  author_name: Schema.optional(Schema.String),
  permalink: Schema.String,
});
const SlackSearch = Schema.Struct({
  ok: Schema.Literal(true),
  results: Schema.Struct({ messages: Schema.Array(SlackHit) }),
});
const decodeSlackSearch = Schema.decodeUnknownEffect(SlackSearch);
/** Your Slack user ID. */
export const SLACK_ME = person(ME)?.slack ?? "";
// Slack answers about 12 of these searches an hour and refuses the rest (measured over 24 h, every hour alike), so
// together they stay at 10 an hour: the ones that alert you every 20 minutes, saved items every hour.
const ALERTS = Duration.minutes(20);
// Strongest reason first: a DM that mentions you is shown as a DM.
const SLACK_FEEDS = [
  { kind: "dm", reason: "sent you a message", query: `to:<@${SLACK_ME}>`, push: true, fresh: ALERTS },
  {
    kind: "mention",
    reason: "mentioned you",
    query: `<@${SLACK_ME}> -from:<@${SLACK_ME}>`,
    push: true,
    fresh: ALERTS,
  },
  {
    kind: "thread_reply",
    reason: "replied in your thread",
    query: `is:thread with:<@${SLACK_ME}> -from:<@${SLACK_ME}>`,
    push: true,
    fresh: ALERTS,
  },
  { kind: "saved", reason: "saved for later", query: "is:saved", push: false, fresh: Duration.hours(1) },
];

const slackKey = (kind: string) => storeKey(`feed:slack:${kind}`, FeedItems);
/** Each Slack search's store key, for the Inbox's age and Slack's health in Settings. */
export const SLACK_SOURCES = SLACK_FEEDS.map((feed) => ({ key: slackKey(feed.kind).name, fresh: feed.fresh }));

/** Successful searches have different cadences; report overdue updates independently of the MCP sign-in. */
export const slackSearchFreshness = Effect.gen(function* () {
  const store = yield* Store;
  const searched = yield* Effect.forEach(SLACK_SOURCES, (source) => store.storedAt(source.key));
  const times = searched.flatMap((at) => (at ? [at.getTime()] : []));
  const complete = times.length === SLACK_SOURCES.length;
  const due = searched.map((at, i) => (at ? at.getTime() + 2 * Duration.toMillis(SLACK_SOURCES[i].fresh) : Infinity));
  return {
    lastSyncedAt: times.length ? DateTime.formatIso(DateTime.makeUnsafe(Math.min(...times))) : null,
    refreshDueAt: complete ? DateTime.formatIso(DateTime.makeUnsafe(Math.min(...due))) : null,
  };
});

/** One search, JSON not Markdown. */
const slackSearch = (feed: (typeof SLACK_FEEDS)[number]) =>
  Effect.gen(function* () {
    const api = yield* SlackApi;
    const now = yield* Clock.currentTimeMillis;
    const method = "assistant.search.context";
    const found = yield* api
      .post(method, {
        query: feed.query,
        channel_types: "public_channel,private_channel,mpim,im",
        sort: "timestamp",
        sort_dir: "desc",
        limit: "20",
        include_bots: "false",
      })
      .pipe(
        Effect.flatMap(decodeSlackSearch),
        Effect.mapError((cause) => (cause instanceof SlackFailure ? cause : new SlackFailure({ method, cause }))),
      );
    return found.results.messages.flatMap((m): FeedItem[] => {
      // Saved is its own list: a saved mention shows under Direct and under Saved, and your own saves count.
      const id = `${feed.kind === "saved" ? "slack-saved" : "slack"}:${m.channel_id}:${m.message_ts}`;
      const at = new Date(Number(m.message_ts) * 1000);
      // Saved items stay however old: they are your Later list, not news.
      if (feed.kind !== "saved" && (!recent(at, now) || m.author_user_id === SLACK_ME)) return [];
      const threadTs = m.permalink.match(/[?&]thread_ts=([\d.]+)/)?.[1];
      return [
        {
          slack: {
            channel: m.channel_id,
            ts: m.message_ts,
            ...(threadTs && threadTs !== m.message_ts ? { threadTs } : {}),
          },
          id,
          source: "slack",
          kind: feed.kind,
          title: m.channel_name ? `#${m.channel_name}` : "Direct message",
          snippet: clip(plain(m.content)),
          actor: m.author_name ?? m.author_user_id,
          url: m.permalink,
          at,
          reason: feed.reason,
          push: feed.push,
        },
      ];
    });
  });

// Messages that arrived over the socket, for 14 days; the Inbox drops the copies the searches also found.
const LIVE_KEY = storeKey("feed:slack:live", FeedItems);

/** Files a message that arrived over the socket in the Inbox now; the searches catch up on it later. */
export const addSlackMessage = Effect.fn("feed.addSlackMessage")(function* (
  event: MessageEvent,
  kind: "dm" | "mention" | "thread_reply",
) {
  const store = yield* Store;
  const now = yield* Clock.currentTimeMillis;
  const feed = SLACK_FEEDS.find((candidate) => candidate.kind === kind);
  const direct = event.channel_type === "im" || event.channel_type === "mpim";
  // Each lookup is cached for a day.
  const name = direct ? undefined : yield* channelName(event.channel);
  const actor = event.user ? yield* userName(event.user) : undefined;
  const workspace = yield* myWorkspace();
  const threadTs = event.thread_ts && event.thread_ts !== event.ts ? event.thread_ts : undefined;
  const preview = slackMessagePreview(event);
  const item: FeedItem = {
    slack: { channel: event.channel, ts: event.ts, ...(threadTs ? { threadTs } : {}) },
    id: `slack:${event.channel}:${event.ts}`,
    source: "slack",
    kind,
    title: preview.title ?? (name ? `#${name}` : "Direct message"),
    snippet: clip(preview.snippet),
    links: preview.links,
    ...(preview.calendarEvent ? { calendarEvent: preview.calendarEvent } : {}),
    actor: actor ? actor : (event.user ?? "someone"),
    url: permalink(workspace ? workspace : "https://slack.com", event),
    at: new Date(Number(event.ts) * 1000),
    reason: preview.reason ?? (feed ? feed.reason : "sent you a message"),
    push: true,
  };
  const kept = ((yield* store.read(LIVE_KEY))?.value ?? []).filter((i) => i.id !== item.id && recent(i.at, now));
  yield* store.write(LIVE_KEY, [item, ...kept].slice(0, 100));
});

/** Runs the searches that alert you now, for what arrived while the socket was down. A refusal keeps the last copy. */
export const refreshSlackSearches = Effect.gen(function* () {
  const store = yield* Store;
  yield* Effect.forEach(
    SLACK_FEEDS.filter((feed) => feed.push),
    (feed) =>
      store
        .refresh(slackKey(feed.kind), slackSearch(feed))
        .pipe(Effect.catch((failure) => Effect.logWarning(`The Slack ${feed.kind} search failed`, failure))),
    { discard: true },
  );
});

/** The threads you posted in over the socket, newest first, so a restart does not forget them. */
const MY_THREADS_KEY = storeKey("slack:my-threads:v1", Schema.Array(Schema.String));
const MY_THREADS_KEPT = 500;

/** Notes that you posted in a thread, so a reply in it belongs in the Inbox. */
export const addSlackThreadOfMine = Effect.fn("feed.addSlackThreadOfMine")(function* (thread: string) {
  const store = yield* Store;
  const before = (yield* store.read(MY_THREADS_KEY))?.value ?? [];
  if (before[0] === thread) return;
  yield* store.write(MY_THREADS_KEY, [thread, ...before.filter((t) => t !== thread)].slice(0, MY_THREADS_KEPT));
});

/**
 * Threads you took part in: the ones you posted in over the socket, and the ones the thread-reply search found. A reply
 * in one of them belongs in the Inbox.
 */
export const slackThreadsOfMine = Effect.gen(function* () {
  const store = yield* Store;
  const posted = (yield* store.read(MY_THREADS_KEY))?.value ?? [];
  const replied = (yield* store.read(slackKey("thread_reply")))?.value ?? [];
  return [...posted, ...replied.flatMap((item) => (item.slack?.threadTs ? [item.slack.threadTs] : []))];
});

/**
 * Four searches, each stored on its own, so one that fails (Slack rate-limits them) keeps its last result and leaves
 * the others. Messages that came over the socket join them until the searches find them.
 */
export const slackFeed = Effect.gen(function* () {
  const store = yield* Store;
  const results = yield* Effect.forEach(SLACK_FEEDS, (feed) =>
    orNothing(`the Slack ${feed.kind} search`, store.cached(slackKey(feed.kind), feed.fresh, slackSearch(feed))),
  );
  const now = yield* Clock.currentTimeMillis;
  const live = ((yield* store.read(LIVE_KEY))?.value ?? []).filter((item) => recent(item.at, now));
  const items = new Map<string, FeedItem>();
  for (const item of [...results.flat(), ...live]) if (!items.has(item.id)) items.set(item.id, item);
  return [...items.values()];
});

// Notion ---------------------------------------------------------------------------------------------

/** Notion has no inbox API: comment threads waiting on you on your Roadmap cards are the signal. */
const notion = Effect.gen(function* () {
  // Built by the sections' refresh (Dashboard.warm) and the Linear watch, not here.
  return ((yield* (yield* Store).read(ROADMAP_KEY))?.value ?? []).flatMap((card): FeedItem[] =>
    card.reply
      ? [
          {
            id: `notion:${card.id}:${card.reply.at.toISOString()}`,
            source: "notion",
            kind: "comment",
            title: card.name,
            snippet: card.reply.count > 1 ? `${card.reply.count} replies waiting` : undefined,
            actor: card.reply.from[0],
            url: card.reply.url,
            at: card.reply.at,
            reason: "replied on your scoping doc",
            push: true,
          },
        ]
      : [],
  );
});

// Feed -----------------------------------------------------------------------------------------------

const GITHUB_KEY = storeKey("feed:github", FeedItems);
// The Inbox loop refreshes the feed and its push sources each minute; older than two minutes means it missed a turn.
export const FEED_FRESH = Duration.minutes(2);
const PUSH_FRESH = Duration.minutes(2);

/** The store keys the Inbox is built from besides its own, and how long each counts as fresh. */
export const INBOX_SOURCES = [
  { key: GITHUB_KEY.name, fresh: PUSH_FRESH },
  { key: NOTIFICATIONS_KEY.name, fresh: PUSH_FRESH },
  ...SLACK_SOURCES,
  { key: ROADMAP_KEY.name, fresh: ROADMAP_FRESH },
];

/**
 * Fetches GitHub and Linear notifications now. The Inbox loop runs this before each build, so a new event is in the
 * feed, and its phone alert sent, within the minute. A failed source keeps its last copy.
 */
export const refreshPushSources = Effect.gen(function* () {
  const store = yield* Store;
  yield* Effect.all(
    [
      (enabled("github") ? store.refresh(GITHUB_KEY, github).pipe(Effect.asVoid) : Effect.void).pipe(
        Effect.catch((error) => Effect.logWarning("Inbox: GitHub failed", error)),
      ),
      (enabled("linear") ? store.refresh(NOTIFICATIONS_KEY, fetchNotifications).pipe(Effect.asVoid) : Effect.void).pipe(
        Effect.catch((error) => Effect.logWarning("Inbox: Linear notifications failed", error)),
      ),
    ],
    { concurrency: "unbounded", discard: true },
  );
}).pipe(Effect.withSpan("feed.refreshPushSources"));

/** One failing source leaves the others in the feed. GitHub, Linear and Notion are read as stored. */
export const buildFeed = Effect.fn("feed.buildFeed")(function* () {
  const store = yield* Store;
  const results = yield* Effect.all(
    [
      enabled("github") ? orNothing("github", store.cached(GITHUB_KEY, Duration.infinity, github)) : Effect.succeed([]),
      enabled("linear") ? orNothing("linear", linear) : Effect.succeed([]),
      enabled("slack") ? orNothing("slack", slackFeed) : Effect.succeed([]),
      enabled("notion") ? orNothing("notion", notion) : Effect.succeed([]),
    ],
    { concurrency: "unbounded" },
  );
  const byId = new Map(results.flat().map((item) => [item.id, item]));
  const items = enabled("classification") ? yield* withTriage([...byId.values()]) : [...byId.values()];
  return items.toSorted((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 200);
});

/** Saved items take the Saved-in-Slack verdicts: how much each still needs you, or why it is done. */
const withTriage = (items: ReadonlyArray<FeedItem>) =>
  Effect.gen(function* () {
    const triage = yield* (yield* Store).read(TRIAGE_KEY).pipe(
      Effect.map((stored) => stored?.value ?? []),
      Effect.catch((error) =>
        Effect.logWarning("Inbox: could not read saved-item verdicts.", error).pipe(Effect.as([])),
      ),
    );
    // A permalink ends in p + the message ts without its dot: /archives/C123/p1790330313334549.
    const byMessage = new Map(
      triage.flatMap((t) => {
        const m = t.permalink.match(/archives\/(\w+)\/p(\d{10})(\d{6})/);
        return m ? [[`${m[1]}:${m[2]}.${m[3]}`, t]] : [];
      }),
    );
    return items.map((item): FeedItem => {
      const verdict =
        item.kind === "saved" && item.slack ? byMessage.get(`${item.slack.channel}:${item.slack.ts}`) : undefined;
      if (!verdict) return item;
      const tickets = verdict.tickets.map((t) => ({
        id: t.id,
        status: t.status,
        statusType: t.statusType,
        priority: t.priority,
        url: t.url,
        mine: t.mine,
      }));
      const withTickets = tickets.length ? { ...item, tickets } : item;
      return verdict.show
        ? verdict.needsYou === undefined
          ? withTickets
          : { ...withTickets, needsYou: verdict.needsYou }
        : { ...withTickets, done: verdict.reason };
    });
  });

/** The Saved-in-Slack verdicts, from the saved search as last stored. */
const triageOfSaved = Effect.gen(function* () {
  const store = yield* Store;
  return yield* buildTriage((yield* store.read(slackKey("saved")))?.value ?? []);
});

/** The verdicts as last built; `Dashboard.warm` rebuilds them once older than TRIAGE_FRESH. */
export const getTriage = Effect.fn("feed.getTriage")(function* () {
  if (!enabled("slack")) return [];
  return yield* (yield* Store).cached(TRIAGE_KEY, TRIAGE_FRESH, triageOfSaved);
});

/** Builds the verdicts now, for when the Linear watch sees your tickets move. */
export const rebuildTriage = Effect.gen(function* () {
  return yield* (yield* Store).refresh(TRIAGE_KEY, triageOfSaved);
});

/** The feed as the Inbox loop last built it (see `Inbox.refreshAndNotify`). */
const getFeed = Effect.gen(function* () {
  const store = yield* Store;
  return yield* store.cached(FEED_KEY, Duration.infinity, buildFeed());
});

// Slack read markers ------------------------------------------------------------------------------------

const SLACK_READ_KEY = storeKey("feed:slack-read", Schema.Record(Schema.String, Schema.Boolean));
const SlackInfo = Schema.Struct({
  ok: Schema.Literal(true),
  channel: Schema.Struct({ last_read: Schema.optional(Schema.String) }),
});
const SlackReplies = Schema.Struct({
  ok: Schema.Literal(true),
  messages: Schema.Array(Schema.Struct({ last_read: Schema.optional(Schema.String) })),
});
const decodeSlackInfo = Schema.decodeUnknownOption(SlackInfo);
const decodeSlackReplies = Schema.decodeUnknownOption(SlackReplies);

/**
 * Whether you have read each Slack item in Slack: a DM or channel message against the conversation's last_read,
 * a thread reply against the thread's. One call per conversation or thread that still has an unread item: an item
 * found read stays read, and items from before the Inbox existed count as read anyway (`readState`).
 */
const slackReads = (items: ReadonlyArray<FeedItem>) =>
  Effect.gen(function* () {
    if (!enabled("slack") || !items.some((item) => item.source === "slack")) return {};
    const mcp = yield* Mcp;
    const api = yield* SlackApi;
    const store = yield* Store;
    const token = yield* mcp.accessToken("slack");
    if (!token) return {};
    const known = (yield* store.read(SLACK_READ_KEY))?.value ?? {};
    const since = (yield* store.read(SINCE_KEY))?.value.getTime() ?? 0;
    const settled = Object.fromEntries(items.flatMap((i) => (known[i.id] ? [[i.id, true]] : [])));
    const at = items.flatMap((i) =>
      i.slack && i.kind !== "saved" && !settled[i.id] && i.at.getTime() >= since ? [{ id: i.id, ...i.slack }] : [],
    );
    const markers = new Map<string, number>();
    const places = [...new Set(at.map((i) => (i.threadTs ? `${i.channel}:${i.threadTs}` : i.channel)))];
    yield* Effect.forEach(
      places,
      (place) =>
        Effect.gen(function* () {
          const [channel, threadTs] = place.split(":");
          const lastRead = threadTs
            ? Option.getOrUndefined(
                decodeSlackReplies(yield* api.get("conversations.replies", { channel, ts: threadTs, limit: "1" })),
              )?.messages[0]?.last_read
            : Option.getOrUndefined(decodeSlackInfo(yield* api.get("conversations.info", { channel })))?.channel
                .last_read;
          if (lastRead) markers.set(place, Number(lastRead));
        }).pipe(
          Effect.catchIf(
            (failure) => failure.error !== undefined,
            () => Effect.void,
          ),
        ),
      { concurrency: 3, discard: true },
    );
    return {
      ...settled,
      ...Object.fromEntries(
        at.flatMap((i) => {
          const marker = markers.get(i.threadTs ? `${i.channel}:${i.threadTs}` : i.channel);
          return marker === undefined ? [] : [[i.id, Number(i.ts) <= marker]];
        }),
      ),
    };
  });

/** The feed with Slack's read state filled in; the unread items' markers refresh every minute. */
export const getFeedWithReads = Effect.fn("feed.getFeedWithReads")(function* () {
  const store = yield* Store;
  const items = yield* withSlackPreviews((yield* getFeed).filter((item) => enabled(item.source)));
  const reads = yield* store
    .cached(SLACK_READ_KEY, Duration.seconds(60), slackReads(items))
    .pipe(
      Effect.catch((error) =>
        Effect.logWarning("Inbox: could not read Slack read markers.", error).pipe(
          Effect.as<Record<string, boolean>>({}),
        ),
      ),
    );
  return items.map((i): FeedItem => {
    const { needsYou: _score, done: _done, ...unclassified } = i;
    const visible = enabled("classification") ? i : unclassified;
    return i.id in reads ? { ...visible, read: reads[i.id] } : visible;
  });
});

/** Older snapshots may have kept only Slack's empty text. Successful exact-message lookups are cached. */
export const withSlackPreviews = Effect.fn("feed.withSlackPreviews")(function* (items: ReadonlyArray<FeedItem>) {
  return yield* Effect.forEach(
    items,
    (item) =>
      Effect.gen(function* () {
        if (item.source !== "slack" || item.snippet !== "" || !item.slack || item.calendarEvent) return item;
        const message = yield* slackMessage(item.slack.channel, item.slack.ts, item.slack.threadTs);
        if (!message) return item;
        const preview = slackMessagePreview(message);
        return {
          ...item,
          title: preview.title ?? item.title,
          snippet: clip(preview.snippet),
          reason: preview.reason ?? item.reason,
          links: preview.links,
          ...(preview.calendarEvent ? { calendarEvent: preview.calendarEvent } : {}),
        };
      }),
    { concurrency: 3 },
  );
});

/**
 * Moves your Slack read marker for a DM, as Slack's own mark read / mark unread does. Channels and threads are
 * left alone: marking a channel mention read would mark the whole channel, and threads have no public API.
 */
const markSlack = (item: FeedItem, isRead: boolean) =>
  Effect.gen(function* () {
    if (!enabled("slack")) return;
    const place = item.slack;
    if (!place || item.kind !== "dm" || place.threadTs) return;
    const mcp = yield* Mcp;
    const token = yield* mcp.accessToken("slack");
    if (!token) return;
    const api = yield* SlackApi;
    // One cursor per DM: never move it back to mark read, or newer messages would turn unread.
    if (isRead) {
      const lastRead = Option.getOrUndefined(
        decodeSlackInfo(yield* api.get("conversations.info", { channel: place.channel })),
      )?.channel.last_read;
      if (lastRead && Number(lastRead) >= Number(place.ts)) return;
    }
    yield* api.post("conversations.mark", { channel: place.channel, ts: isRead ? place.ts : justBefore(place.ts) });
    // Only this entry: dropping the map would make the next Inbox load wait on a Slack call per conversation.
    const store = yield* Store;
    const reads = yield* store.read(SLACK_READ_KEY);
    if (reads) yield* store.write(SLACK_READ_KEY, { ...reads.value, [item.id]: isRead });
  });

const SEEN_KEY = storeKey("feed:seen", Schema.Array(Schema.String));

/**
 * Pushes items the Mac has not seen before. The first run only remembers what is there, so starting the Mac
 * does not replay two weeks of history; an item that turns up late (older than an hour) is listed, not pushed.
 * An item whose alert failed stays unseen, so the next run tries it again.
 */
export const notifyNew = Effect.fn("feed.notifyNew")(function* (items: ReadonlyArray<FeedItem>) {
  if (!enabled("notifications")) return;
  const store = yield* Store;
  const seen = (yield* store.read(SEEN_KEY))?.value;
  const known = new Set(seen ?? []);
  const unsent = new Set<string>();
  if (seen) {
    const now = yield* Clock.currentTimeMillis;
    const fresh = items.filter((i) => !known.has(i.id) && i.push && now - i.at.getTime() < 60 * 60 * 1000);
    const name = (i: FeedItem) => (i.actor ? (person(i.actor)?.name.split(" ")[0] ?? i.actor) : undefined);
    // A burst (the Mac waking up, a busy thread) becomes one summary, not a stack of banners.
    const alerts =
      fresh.length > 3
        ? [
            {
              ids: fresh.map((i) => i.id),
              alert: {
                title: `${fresh.length} new in Inbox`,
                body: fresh
                  .slice(0, 3)
                  .map((i) => i.title)
                  .join(" · "),
                url: "mondash://",
              },
            },
          ]
        : fresh.map((i) => ({
            ids: [i.id],
            alert: {
              title: [name(i), i.reason].filter(Boolean).join(" "),
              body: i.snippet ? `${i.title}: ${i.snippet}` : i.title,
              url: i.url,
              tag: i.source,
            },
          }));
    for (const { ids, alert } of alerts)
      yield* notify(alert).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Phone alert failed", error).pipe(
            Effect.andThen(Effect.sync(() => ids.forEach((id) => unsent.add(id)))),
          ),
        ),
      );
  }
  const ids = items.map((i) => i.id).filter((id) => !unsent.has(id));
  yield* store.write(SEEN_KEY, [...new Set([...ids, ...known])].slice(0, 3000));
});

// Tabs and read state ---------------------------------------------------------------------------------

/** Your mark from the Inbox (see `Override`); marks saved before the source was recorded are plain booleans. */
const READ_KEY = storeKey("feed:read", Schema.Record(Schema.String, Schema.Union([Override, Schema.Boolean])));
const SINCE_KEY = storeKey("feed:since", Schema.Date);

/**
 * Your choice from the Inbox, stored on the Mac with what the source said at the time. Slack DMs are also marked
 * in Slack; everything else stays in Mondash until the source itself changes.
 */
// ponytail: one entry per item ever toggled; prune by feed:seen if this ever grows large.
export const setRead = Effect.fn("feed.setRead")(function* (id: string, isRead: boolean) {
  const store = yield* Store;
  const item = (yield* getFeedWithReads()).find((i) => i.id === id);
  const overrides = (yield* store.read(READ_KEY))?.value ?? {};
  yield* store.write(READ_KEY, {
    ...overrides,
    [id]: { read: isRead, ...(item?.read === undefined ? {} : { source: item.read }) },
  });
  // Mondash keeps your choice even if Slack refuses; it syncs again once Slack's marker moves.
  if (item)
    yield* markSlack(item, isRead).pipe(Effect.catch((error) => Effect.logWarning("Could not mark Slack DM", error)));
});

/**
 * Your choice holds until the source's own read state changes (you read it in Slack, GitHub or Linear); then the
 * source wins. Items from before the Inbox existed start read, so the first view is not two weeks of unread Slack.
 */
export const readState = Effect.fn("feed.readState")(function* () {
  const store = yield* Store;
  const overrides = (yield* store.read(READ_KEY))?.value ?? {};
  let since = (yield* store.read(SINCE_KEY))?.value;
  if (!since) {
    since = new Date(yield* Clock.currentTimeMillis);
    yield* store.write(SINCE_KEY, since);
  }
  const start = since.getTime();
  return (item: FeedItem): boolean => {
    const raw = overrides[item.id];
    return isRead(typeof raw === "boolean" ? { read: raw } : raw, item.read, item.at.getTime() < start);
  };
});
