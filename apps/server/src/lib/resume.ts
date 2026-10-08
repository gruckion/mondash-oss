import { enabled } from "../profile";
import { Clock, Duration, Effect, Schema, Struct } from "effect";
import { issueStateRank } from "@mondash/shared/issue-order";
import { getPrDMs } from "@/lib/dm";
import { assignmentNotifications, getMine, type Mine } from "@/lib/linear-api";
import { getMyOtherPRs, getMyOpenPRs, OTHER_PRS_KEY, prKey, PRS_FRESH, PRS_KEY, PullRequest } from "@/lib/github";
import { linearHref, notionHref, slackHref } from "@/lib/app-links";
import { parseSearch, parseThread, plain } from "@/lib/slack";
import { channelName } from "@/lib/slack-web";
import { LinearIssue, type Ticket } from "@/lib/triage";
import { Reply } from "@/lib/people";
import { countRefs, refKeys } from "@/lib/refs";
import { ticketReply, type TicketComment } from "@/lib/ticket-comments";
import { matchSessions, ScoredSessions, type WorkItem } from "@/lib/session-match";
import { getSessionsMentioning } from "@/lib/sessions";
import { Mcp } from "@/services/mcp";
import { Store, storeKey } from "@/services/store";

const Assigned = Schema.Struct({ at: Schema.Date, by: Schema.optional(Schema.String) });
type Assigned = typeof Assigned.Type;

/**
 * When each ticket was assigned to you, and by whom, from Linear's own notifications ("Assigned by Renée Frost").
 * The issue itself carries no assignment history, so this is the only record. Self-assignment sends no
 * notification, so a ticket missing here fell to you some other way; the first sighting is kept for those.
 */
const assignments = Effect.gen(function* () {
  const rows = yield* assignmentNotifications.pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not read Linear notifications.", error).pipe(Effect.as(undefined)),
    ),
  );
  const byTicket = new Map<string, Assigned>();
  if (rows === undefined) return byTicket;
  for (const n of rows.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const id = n.url.match(/\/issue\/([A-Z]+-\d+)/)?.[1];
    if (!id) continue;
    const by = n.subtitle?.match(/^Assigned by (.+)$/)?.[1];
    byTicket.set(id, { at: new Date(n.createdAt), by });
  }
  return byTicket;
});

/** What Linear says, or the first sighting when it said nothing (you assigned it to yourself). */
const assignedTo = (byTicket: Map<string, Assigned>, id: string) =>
  Effect.gen(function* () {
    const known = byTicket.get(id);
    return known ? known : { at: yield* firstSeen(id) };
  });

/** When the dashboard first saw a ticket as yours: the fallback when Linear sent no notification. */
const firstSeen = (id: string) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const key = storeKey(`assigned:${id}`, Schema.Date);
    const seen = yield* store.read(key);
    if (seen) return seen.value;
    const now = new Date(yield* Clock.currentTimeMillis);
    yield* store.write(key, now);
    return now;
  });

/** The comment on a ticket that is waiting on you, from the comments your issues query already brought. */
const commentsWaiting = (comments: Mine["issues"][number]["comments"], url: string, me: string, yours: boolean) => {
  const reply = ticketReply(
    comments.map((c): TicketComment => ({
      id: c.id,
      author: c.author,
      createdAt: new Date(c.createdAt),
      parentId: c.parentId ? c.parentId : undefined,
      resolved: Boolean(c.resolvedAt),
    })),
    me,
    yours,
    url,
  );
  // The comment link opens in the Linear app, like every other Linear link on the page.
  return reply && { ...reply, url: linearHref(reply.url) };
};
const SearchResult = Schema.Struct({ results: Schema.String });
const ThreadResult = Schema.Struct({ messages: Schema.String });
const decodeSearchResult = Schema.decodeUnknownEffect(Schema.fromJsonString(SearchResult));
const decodeThreadResult = Schema.decodeUnknownEffect(Schema.fromJsonString(ThreadResult));

/** A Notion Roadmap card a ticket belongs to. */
const NotionLink = Schema.Struct({ url: Schema.String, title: Schema.String });
type NotionLink = typeof NotionLink.Type;
const isNotion = (url: string) => /(^|\.)notion\.(so|com|site)$/.test(new URL(url).hostname);

/** `url` is the web link (for keys and linking); `href` opens it, in the Slack app if installed. */
const SlackThread = Schema.Struct({
  url: Schema.String,
  href: Schema.String,
  title: Schema.String,
  subtitle: Schema.optional(Schema.String),
  channel: Schema.optional(Schema.String),
  postedAt: Schema.optional(Schema.Date),
});
type SlackThread = typeof SlackThread.Type;

/** A channel thread that mentions the ticket ID but is not attached to the ticket in Linear. */
export const UnlinkedThread = Schema.Struct({
  url: Schema.String,
  href: Schema.String,
  channel: Schema.String,
  from: Schema.String,
  text: Schema.String,
  replyCount: Schema.Finite,
  participants: Schema.Array(Schema.String),
  lastAt: Schema.optional(Schema.Date),
});
export type UnlinkedThread = typeof UnlinkedThread.Type;

export const ActiveTicket = Schema.Struct({
  ...LinearIssue.fields,
  prs: Schema.Array(PullRequest),
  /** Its PRs merged or closed in the last week, kept in a collapsed history row. */
  otherPRs: Schema.Array(PullRequest),
  sessions: ScoredSessions,
  slack: Schema.Array(SlackThread),
  notion: Schema.Array(NotionLink),
  /** Linear comments waiting on you. */
  reply: Schema.NullOr(Reply),
  /** When it became yours, and who put it on you. `by` is undefined when you assigned it to yourself. */
  assigned: Assigned,
});
export type ActiveTicket = typeof ActiveTicket.Type;

/** Sections in Linear's "My issues" order. Backlog starts collapsed. */
const Section = Schema.Struct({ title: Schema.String, tickets: Schema.Array(ActiveTicket), collapsed: Schema.Boolean });
type Section = typeof Section.Type;

export const Resume = Schema.Struct({
  sections: Schema.Array(Section),
  /** Label name (lowercased) to its Linear colour, for the chips. */
  labelColours: Schema.Record(Schema.String, Schema.String),
  otherPRs: Schema.Array(Schema.Struct({ ...PullRequest.fields, sessions: Schema.optional(ScoredSessions) })),
  draftPRs: Schema.optional(
    Schema.Array(Schema.Struct({ ...PullRequest.fields, sessions: Schema.optional(ScoredSessions) })),
  ),
});
export type Resume = typeof Resume.Type;

const DAY = 24 * 60 * 60 * 1000;

/** Linear markdown to plain text: @[name](id) → @name, [label](url) → label. */
const linearPlain = (text: string) =>
  text.replace(/@\[([^\]]+)\]\([^)]+\)/g, "@$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

/** True if the ticket ID (e.g. DEMO-4148) appears in any of the texts, ignoring case. */
export const mentions = (id: string, ...texts: (string | undefined)[]) =>
  texts.some((t) => t !== undefined && new RegExp(`\\b${id}\\b`, "i").test(t));

export const RESUME_KEY = storeKey("resume:v17", Resume);
// ponytail: one minute, tuned by how fast it rebuilds.
export const RESUME_FRESH = Duration.minutes(1);

/**
 * The Resume column, as last built. Outside `ReadOnly`, a copy older than RESUME_FRESH is still answered at once and
 * rebuilt behind it; the stream sends the new one.
 */
export const getResume = Effect.fn("resume.getResume")(function* () {
  const store = yield* Store;
  return yield* store.cached(RESUME_KEY, RESUME_FRESH, buildResume);
});

/** Builds it now. Used when a live event says a source moved. */
export const rebuildResume = Effect.gen(function* () {
  const store = yield* Store;
  return yield* store.refresh(RESUME_KEY, buildResume);
});

/** Your open Linear tickets in Linear's "My issues" sections, each with its Slack threads, PRs and agent sessions. */
const buildResume = Effect.gen(function* () {
  const store = yield* Store;
  const optionalPRs = (source: Effect.Effect<readonly PullRequest[], unknown, Store | import("@/services/gh").Gh>) =>
    source.pipe(
      Effect.catch((error) =>
        Effect.logWarning("GitHub enrichment unavailable; keeping Linear work", error).pipe(
          Effect.as<readonly PullRequest[]>([]),
        ),
      ),
    );
  const [mine, prs, history] = yield* Effect.all(
    [
      // One request: your open issues with their attachments, comments and project links. live.ts keeps it fresh.
      getMine,
      enabled("github") ? optionalPRs(store.cached(PRS_KEY, PRS_FRESH, getMyOpenPRs())) : Effect.succeed([]),
      enabled("github") ? optionalPRs(store.cached(OTHER_PRS_KEY, "5 minutes", getMyOtherPRs())) : Effect.succeed([]),
    ],
    { concurrency: "unbounded" },
  );
  const { me } = mine;
  const extras = new Map(mine.issues.map((i) => [i.id, i]));
  const issues = mine.issues.map((i) => Struct.omit(i, ["comments", "projectLinks"]));

  // A Slack DM can be the only place a reviewer says what is missing, so each PR carries its waiting DM.
  const dms = yield* getPrDMs(
    prs.map((pr) => ({
      key: prKey(pr),
      title: pr.title,
      state: pr.isDraft ? "draft" : pr.review ? pr.review : "open",
      createdAt: pr.createdAt,
      yourLastActivityAt: pr.yourLastActivityAt,
      people: pr.people,
      approvedBy: pr.approvedBy,
      waitingBy: pr.waitingBy,
    })),
  );
  const withDMs = prs.map((pr) => ({ ...pr, dm: dms.get(prKey(pr)) }));

  const matched = issues.map((issue) => {
    // Linear's own attachments catch PRs whose branch and title never name the ticket, e.g. fix/refund-provider-reconciliation.
    const attached = new Set(issue.attachments.map((a) => a.url));
    return {
      ...issue,
      slack: issue.attachments.filter((a) => new URL(a.url).hostname.endsWith("slack.com")),
      prs: withDMs.filter((pr) => attached.has(pr.url) || mentions(issue.id, pr.branch, pr.title)),
      otherPRs: history.filter((pr) => attached.has(pr.url) || mentions(issue.id, pr.branch, pr.title)),
    };
  });

  const usedPRs = new Set(matched.flatMap((t) => t.prs));
  const now = yield* Clock.currentTimeMillis;
  // Keep the existing 14-day cutoff for standalone PRs.
  const otherPRs = withDMs.filter((pr) => !usedPRs.has(pr) && !pr.isDraft && now - pr.updatedAt.getTime() < 14 * DAY);
  const draftPRs = withDMs.filter((pr) => pr.isDraft);

  // A session belongs to a ticket if it mentions the ticket's ID or branch, its PRs or its Slack threads, and Jev agrees.
  // Searched back 90 days: a ticket's early sessions are often older than a week.
  const items = matched.map((t): WorkItem => ({
    key: t.id,
    kind: "Linear ticket",
    title: t.title,
    status: t.status,
    // Not its Notion link: that names the whole Roadmap card, and the card has its own sessions.
    refs: [
      `ticket:${t.id}`,
      ...[...t.prs, ...t.otherPRs].flatMap((pr) => refKeys(pr.url)),
      ...t.attachments.flatMap((a) => refKeys(a.url)).filter((k) => !k.startsWith("notion:")),
    ],
    // Linear attachments can be related PRs someone linked for reference; only the ticket's own PRs count.
    ownPRs: [...t.prs, ...t.otherPRs].flatMap((pr) => refKeys(pr.url)),
  }));
  // Include standalone PRs in the same 90-day search and relevance matching pass.
  items.push(
    ...[...otherPRs, ...draftPRs].map((pr): WorkItem => ({
      key: pr.url,
      kind: "Pull request",
      title: pr.title,
      status: pr.review ?? "Open",
      refs: [
        ...refKeys(pr.url),
        ...Object.keys(countRefs(`${pr.title} ${pr.branch}`)).filter((key) => key.startsWith("ticket:")),
      ],
    })),
  );
  const bySession = yield* matchSessions(items, yield* getSessionsMentioning(items.flatMap((i) => i.refs)));
  const tickets = matched.map((t) => {
    const found = bySession.get(t.id);
    return { ...t, sessions: found ? found : [] };
  });
  const assigned = yield* assignments;
  const colours = mine.labelColours;
  const projectNotion = new Map(
    mine.issues.flatMap((i): [string, NotionLink[]][] =>
      i.projectId
        ? [
            [
              i.projectId,
              i.projectLinks
                .filter((r) => isNotion(r.url))
                .map((r) => ({ url: notionHref(r.url, r.label), title: r.label })),
            ],
          ]
        : [],
    ),
  );
  const withSlack = yield* Effect.forEach(
    tickets,
    (t) =>
      Effect.gen(function* () {
        return {
          ...t,
          slack: yield* Effect.forEach(t.slack, slackThread, { concurrency: "unbounded" }),
          notion: enabled("notion") ? notionLinks(t, projectNotion) : [],
          reply: commentsWaiting(extras.get(t.id)?.comments ?? [], t.url, me.email, t.assigneeId === me.id),
          assigned: yield* assignedTo(assigned, t.id),
        };
      }),
    { concurrency: "unbounded" },
  );

  return {
    // Priority, then work already in progress, then launch blockers and your own latest work.
    labelColours: colours,
    sections: sections(withSlack.toSorted(compareIssueTickets)),
    // ponytail: 14-day cut-off hides years-old PRs in personal repos; tune if idle-but-open PRs matter.
    otherPRs: otherPRs.map((pr) => ({ ...pr, sessions: bySession.get(pr.url) ?? [] })),
    draftPRs: draftPRs.map((pr) => ({ ...pr, sessions: bySession.get(pr.url) ?? [] })),
  } satisfies Resume;
});

/** Groups sorted tickets like Linear's "My issues": Urgent, Other active, Triage, Backlog. Empty sections are dropped. */
function sections(tickets: ReadonlyArray<ActiveTicket>): Section[] {
  const urgent = (t: ActiveTicket) => t.priority.value === 1;
  return [
    { title: "Urgent", tickets: tickets.filter(urgent), collapsed: false },
    {
      title: "Assigned",
      tickets: tickets.filter((t) => !urgent(t) && (t.statusType === "started" || t.statusType === "unstarted")),
      collapsed: false,
    },
    // "New" not "Triage": the Slack saved items are the Triage the rest of the app means.
    { title: "New", tickets: tickets.filter((t) => !urgent(t) && t.statusType === "triage"), collapsed: false },
    { title: "Backlog", tickets: tickets.filter((t) => !urgent(t) && t.statusType === "backlog"), collapsed: true },
  ].filter((section) => section.tickets.length > 0);
}

/** "channel:thread_ts" for a Slack permalink, so linked and found threads can be compared. */
function threadKey(url: string) {
  const u = new URL(url);
  const match = u.pathname.match(/\/archives\/(\w+)\/p(\d{10})(\d{6})/);
  if (!match) return undefined;
  const threadTs = u.searchParams.get("thread_ts");
  return `${match[1]}:${threadTs ? threadTs : `${match[2]}.${match[3]}`}`;
}

// Slack search results and threads can change, but a few minutes of staleness is fine here.
const SLACK_CACHE = "5 minutes";

/**
 * For each ticket, channel threads whose messages mention the ticket ID but are not attached in Linear.
 * DMs and group DMs are left out: they are private side-talk, not the ticket's discussion.
 * Up to 3 Slack calls run at once, and results are cached, so reloads are fast. A ticket whose search fails has no
 * threads this time; the others still show.
 */
export const findUnlinkedThreads = Effect.fn("resume.findUnlinkedThreads")(function* (
  tickets: ReadonlyArray<ActiveTicket>,
) {
  if (!enabled("slack")) return new Map<string, UnlinkedThread[]>();
  const mcp = yield* Mcp;
  const perTicket = yield* Effect.forEach(
    tickets,
    (ticket) =>
      Effect.gen(function* () {
        const linked = new Set(ticket.attachments.map((a) => threadKey(a.url)));
        const search = yield* mcp
          .cachedCall(
            "slack",
            "slack_search_public_and_private",
            { query: ticket.id, limit: 20, include_context: false },
            SLACK_CACHE,
          )
          .pipe(Effect.flatMap(decodeSearchResult));
        const hits = parseSearch(search.results).filter(
          (m) =>
            m.channel.startsWith("#") && mentions(ticket.id, m.text) && !linked.has(`${m.channelId}:${m.threadTs}`),
        );
        const firstPerThread = [...Map.groupBy(hits, (m) => `${m.channelId}:${m.threadTs}`).values()].map(
          ([hit]) => hit,
        );
        const threads = yield* Effect.forEach(
          firstPerThread,
          (hit) =>
            Effect.gen(function* () {
              const messages = yield* mcp
                .cachedCall(
                  "slack",
                  "slack_read_thread",
                  { channel_id: hit.channelId, message_ts: hit.threadTs },
                  SLACK_CACHE,
                )
                .pipe(
                  Effect.flatMap(decodeThreadResult),
                  Effect.map((result) => result.messages),
                  Effect.catch((error) =>
                    Effect.logWarning(
                      `Could not read Slack thread ${hit.channelId}/${hit.threadTs}; using the search hit only.`,
                      error,
                    ).pipe(Effect.as("")),
                  ),
                );
              const thread = parseThread(messages);
              return {
                url: hit.permalink,
                href: yield* slackHref(hit.permalink),
                channel: hit.channel,
                from: thread.from ?? hit.from,
                text: plain(thread.text || hit.text),
                replyCount: thread.replyCount,
                participants: thread.participants,
                lastAt: thread.lastAt,
              } satisfies UnlinkedThread;
            }),
          // One at a time: the tickets already run 3 at once, which is the Slack limit.
          { concurrency: 1 },
        );
        return [ticket.id, threads] satisfies [string, UnlinkedThread[]];
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning(`Could not find Slack threads for ${ticket.id}.`, error).pipe(
            Effect.as<[string, UnlinkedThread[]]>([ticket.id, []]),
          ),
        ),
      ),
    { concurrency: 3 },
  );
  return new Map(perTicket.filter(([, threads]) => threads.length > 0));
});

/**
 * The ticket's Notion cards: its own Notion attachments, else its Linear project's Notion links.
 * The attachment wins, so a ticket filed under a catch-all project can still name its card.
 */
function notionLinks(t: Ticket, byProject: Map<string, NotionLink[]>): NotionLink[] {
  const own = t.attachments
    .filter((a) => isNotion(a.url))
    .map((a) => ({ url: notionHref(a.url, a.title), title: a.title }));
  if (own.length) return own;
  const project = t.projectId ? byProject.get(t.projectId) : undefined;
  return project ? project : [];
}

/** A Linear attachment to a Slack message, with the channel name and message time from its URL. */
const slackThread = (a: { url: string; title: string; subtitle?: string | null }) =>
  Effect.gen(function* () {
    // Slack permalinks look like /archives/<channel id>/p<ts without the dot>.
    const match = new URL(a.url).pathname.match(/\/archives\/(\w+)\/p(\d{10})(\d{6})/);
    return {
      url: a.url,
      href: yield* slackHref(a.url),
      // The icon and "#channel:" already say it is a Slack thread, so drop that prefix from the title.
      title: a.title.replace(/^slack thread(?: in #[\w-]+)?\s*[—–:-]?\s*/i, ""),
      subtitle: a.subtitle ? linearPlain(a.subtitle) : undefined,
      channel: match ? yield* channelName(match[1]) : undefined,
      postedAt: match ? new Date(Number(`${match[2]}.${match[3]}`) * 1000) : undefined,
    } satisfies SlackThread;
  });

/** Linear priority as a sort key: Urgent (1) first, Low (4), then No priority (0) last. */
const rank = (t: ActiveTicket) => (t.priority.value === 0 ? 5 : t.priority.value);

/** In-progress work wins a priority tie; blocker labels and activity settle the remaining ties. */
export const compareIssueTickets = (a: ActiveTicket, b: ActiveTicket) =>
  rank(a) - rank(b) ||
  issueStateRank(a.statusType, a.status) - issueStateRank(b.statusType, b.status) ||
  Number(blocker(b)) - Number(blocker(a)) ||
  yourLatest(b) - yourLatest(a);

/** The "LAUNCH BLOCKER" label: among tickets of the same priority, these go first. */
export const blocker = (t: { labels?: ReadonlyArray<string> }) =>
  t.labels ? t.labels.some((l) => l.toLowerCase() === "launch blocker") : false;

/**
 * Your own latest activity on a ticket: its PRs and agent sessions.
 * Not the ticket's updatedAt: any edit by anyone changes that.
 */
function yourLatest(t: ActiveTicket) {
  return Math.max(0, ...t.prs.map((p) => p.updatedAt.getTime()), ...t.sessions.map((s) => s.updatedAt.getTime()));
}
