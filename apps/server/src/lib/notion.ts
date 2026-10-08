import { parseNotionSchema, notionSchemaFingerprint } from "./settings-notion";
import { enabled } from "../profile";
import { profile, notionProperties } from "../profile";
import { Duration, Effect, Option, Result, Schema } from "effect";
import { docMentions } from "@/lib/doc-mentions";
import { notionHref } from "@/lib/app-links";
import { noul } from "@/lib/jev";
import { linearHref } from "@/lib/app-links";
import { issuesById, LinearIssue } from "@/lib/linear-api";
import { notionReply, parseDiscussions } from "@/lib/notion-comments";
import { parseThread, plain } from "@/lib/slack";
import { channelName, myWorkspace } from "@/lib/slack-web";
import { slackHref } from "@/lib/app-links";
import { displayName, Reply } from "@/lib/people";
import { matchSessions, ScoredSessions, type WorkItem } from "@/lib/session-match";
import { getSessionsMentioning } from "@/lib/sessions";
import { Mcp, McpFailure } from "@/services/mcp";
import { Store, storeKey } from "@/services/store";

// The Roadmap's "Table" view: every card in the In progress status group, for everyone.
// View mode, not SQL or rows: those count against a small workspace quota ("usage limit for Query Data Source").
// The user selects the view and property/status mapping in their private profile.
const ROADMAP_VIEW = profile.notion.view;

// Statuses where the card is still a Notion doc. From Todo on, the work is in Linear.
const SCOPING = profile.notion.scoping;
const OPEN = profile.notion.open;
const READY_TO_REVIEW = profile.notion.readyToReview;

const PRIORITY: Record<string, number> = { High: 1, Medium: 2, Low: 3 };

/** A Linear ticket named in the card's text that Jev says is this card's work. */
const CardTicket = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: Schema.String,
  statusType: Schema.String,
  priority: LinearIssue.fields.priority,
  href: Schema.String,
  /** Absent when Jev could not judge it: the ticket is kept, with no score. */
  jev: Schema.optional(Schema.Finite),
  updatedAt: Schema.String,
});
type CardTicket = typeof CardTicket.Type;

/** A Slack thread linked inside the card's own text. */
const CardThread = Schema.Struct({
  url: Schema.String,
  href: Schema.String,
  channel: Schema.optional(Schema.String),
  from: Schema.optional(Schema.String),
  text: Schema.String,
  replyCount: Schema.Finite,
  at: Schema.optional(Schema.Date),
});
type CardThread = typeof CardThread.Type;

export const RoadmapCard = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  name: Schema.String,
  status: Schema.String,
  priority: Schema.optional(Schema.String),
  role: Schema.Literals(["owner", "reviewer"]),
  reply: Schema.NullOr(Reply),
  /** Sessions that contain the card's link and that Jev says are work on the card. */
  sessions: ScoredSessions,
  /** Slack threads the doc itself links to: where the thing was discussed. */
  slack: Schema.Array(CardThread),
  /** Linear tickets the doc names that are this card's work, not just related reading. */
  tickets: Schema.Array(CardTicket),
  /** Who reviews it, by email, so the card shows whose desk it is on next. */
  reviewers: Schema.Array(Schema.String),
});
export type RoadmapCard = typeof RoadmapCard.Type;

// Person properties come back as a JSON array of "user://<id>" strings.
const People = Schema.fromJsonString(Schema.Array(Schema.String));
const Row = Schema.Struct({
  url: Schema.String,
  Name: Schema.String,
  Status: Schema.String,
  Priority: Schema.optional(Schema.String),
  Assign: Schema.optional(People),
  Reviewer: Schema.optional(People),
});
const decodeRow = Schema.decodeUnknownOption(Row);
const decodeRows = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ results: Schema.Array(Schema.Unknown), has_more: Schema.optional(Schema.Boolean) }),
  ),
);
const decodeUsers = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      results: Schema.Array(Schema.Struct({ id: Schema.String, email: Schema.optional(Schema.String) })),
    }),
  ),
);
// A page with no open comments has no "text" at all.
const decodePage = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ text: Schema.String })));
const decodeThread = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ messages: Schema.String })));

// Notion writes a linked Slack message as slackMessage://<workspace>/<channel>/<ts>/<threadTs>; a pasted link is the web form.
const SLACK_LINKS =
  /(?:slackMessage:\/\/[\w.-]+|[\w.-]+\.slack\.com)\/(C\w+)\/(\d{10}\.\d{6})(?:\/(\d{10}\.\d{6}))?|\/archives\/(C\w+)\/p(\d{10})(\d{6})/g;

/** A card's own text, read once and used for both its Slack links and its ticket mentions. */
const cardPage = (pageId: string) =>
  Effect.gen(function* () {
    const mcp = yield* Mcp;
    return (yield* decodePage(yield* mcp.cachedCall("notion", "notion-fetch", { id: pageId }, "5 minutes"))).text;
  }).pipe(
    Effect.catch((error) => Effect.logWarning(`Could not read the Notion page ${pageId}.`, error).pipe(Effect.as(""))),
  );

/** The Slack threads a card's own text links to, read once each. */
const cardThreads = (page: string, workspace: string | undefined) =>
  Effect.gen(function* () {
    const mcp = yield* Mcp;
    const links = new Map<string, { channel: string; ts: string }>();
    for (const m of page.matchAll(SLACK_LINKS)) {
      const channel = m[1] ? m[1] : m[4];
      const ts = m[3] ? m[3] : m[2] ? m[2] : `${m[5]}.${m[6]}`;
      if (channel && ts) links.set(`${channel}:${ts}`, { channel, ts });
    }
    return yield* Effect.forEach(
      [...links.values()],
      ({ channel, ts }) =>
        Effect.gen(function* () {
          const messages = yield* mcp
            .cachedCall("slack", "slack_read_thread", { channel_id: channel, message_ts: ts }, "5 minutes")
            .pipe(
              Effect.flatMap(decodeThread),
              Effect.map((t) => t.messages),
              Effect.orElseSucceed(() => ""),
            );
          const thread = parseThread(messages);
          const url = `${workspace ? workspace : "https://slack.com/"}archives/${channel}/p${ts.replace(".", "")}`;
          return {
            url,
            href: yield* slackHref(url),
            channel: yield* channelName(channel),
            from: thread.from,
            text: plain(thread.text),
            replyCount: thread.replyCount,
            at: thread.lastAt,
          } satisfies CardThread;
        }),
      { concurrency: 3 },
    );
  });

// A doc names a ticket either as its own work or as related reading, and only the sentence around it says which.
// 400 characters each side: enough for the sentence and its heading, which is what says "ours" or "related reading".
const CONTEXT = 400;
// ponytail: 0.5, because a doc naming its own ticket in passing still scores around 0.55, while related
// reading sits near 0.3. The score is in the chip's tooltip, so a borderline call is visible.
const TICKET_THRESHOLD = 0.5;

/**
 * The Linear tickets a card's text names, kept when Jev says they are the card's own work. `issues` is one lookup for
 * every card of the build; when it failed, each ticket keeps its last state.
 */
const cardTickets = (
  page: string,
  card: { id: string; name: string; status: string; owners: string[] },
  before: ReadonlyArray<CardTicket>,
  issues: Result.Result<ReadonlyMap<string, typeof LinearIssue.Type>, unknown>,
) =>
  Effect.gen(function* () {
    const store = yield* Store;
    // The card's creation date, from its properties: a ticket closed before then cannot be this card's work.
    const created = page.match(/"Created":"([^"]+)"/)?.[1]?.slice(0, 10);
    const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : undefined);
    const mentions = enabled("linear") ? docMentions(page, CONTEXT) : new Map<string, string>();
    const found = yield* Effect.forEach(
      [...mentions],
      ([id, mention]) =>
        Effect.gen(function* () {
          if (Result.isFailure(issues)) return before.filter((t) => t.id.toUpperCase() === id);
          const issue = issues.success.get(id);
          if (issue === undefined) return []; // not a Linear ticket, e.g. "ISO-8601"
          const jev = enabled("classification")
            ? yield* store
                .cached(
                  storeKey(["jev-card-ticket:v3", card.id, id, String(mention.length)].join(":"), Schema.Finite),
                  Duration.days(1),
                  noul(
                    {
                      roadmap_card: { name: card.name, status: card.status, owners: card.owners, created },
                      ticket: {
                        id,
                        title: issue.title,
                        status: issue.status,
                        asks_for: issue.description ? issue.description.replace(/\s+/g, " ").slice(0, 300) : undefined,
                        assignee: issue.assignee ? displayName(issue.assignee) : "unassigned",
                        created: day(issue.createdAt),
                        closed: day(issue.canceledAt ?? issue.completedAt),
                      },
                      how_the_doc_mentions_it: mention,
                    },
                    {
                      true: "This ticket is the card's own work: the card was created to scope what the ticket asks for, the ticket came out of this scoping, or it tracks a piece of it.",
                      false:
                        "The doc only names it as related background, an example, prior art, or work someone else owns; or the ticket was cancelled or completed before this card was created.",
                    },
                  ),
                )
                .pipe(
                  Effect.catch((error) =>
                    Effect.logWarning(`Jev could not judge ${id} on ${card.name}.`, error).pipe(Effect.as(undefined)),
                  ),
                )
            : undefined;
          return jev === undefined || jev >= TICKET_THRESHOLD
            ? [
                {
                  id: issue.id,
                  title: issue.title,
                  status: issue.status,
                  statusType: issue.statusType,
                  priority: issue.priority,
                  href: linearHref(issue.url),
                  ...(jev === undefined ? {} : { jev }),
                  updatedAt: issue.updatedAt,
                } satisfies CardTicket,
              ]
            : [];
        }),
      { concurrency: 3 },
    );
    return found.flat();
  });

const decodeComments = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ text: Schema.optional(Schema.String) })),
);

const pageId = (url: string) => url.match(/[0-9a-f]{32}/)?.[0];

/** Open Roadmap cards you own or review that need you, each with its agent sessions. */
const loadRoadmapCards = Effect.gen(function* () {
  const mcp = yield* Mcp;
  const store = yield* Store;
  if (profile.notion.sourceId && profile.notion.fingerprint) {
    const schema = parseNotionSchema(
      yield* mcp.cachedCall(
        "notion",
        "notion-fetch",
        { id: `collection://${profile.notion.sourceId}` },
        Duration.minutes(5),
      ),
    ).schema;
    if (!schema || notionSchemaFingerprint(schema) !== profile.notion.fingerprint)
      return yield* new McpFailure({
        server: "notion",
        cause:
          "This board’s fields or workflow changed. Choose its saved view again in Settings to confirm the mapping. Your last snapshot is retained.",
      });
  }
  const [users, everyone, workspace] = yield* Effect.all(
    [
      mcp.cachedCall("notion", "notion-get-users", { user_id: "self" }, Duration.days(1)),
      // Notion names a reviewer by ID only, so the workspace list turns that into the email people.ts knows.
      mcp.cachedCall("notion", "notion-get-users", {}, Duration.days(1)).pipe(
        Effect.flatMap(decodeUsers),
        Effect.map((decoded) => decoded.results),
        Effect.orElseSucceed((): { id: string; email?: string }[] => []),
      ),
      enabled("slack") ? myWorkspace() : Effect.succeed(undefined),
    ],
    { concurrency: "unbounded" },
  );
  const emailById = new Map(everyone.flatMap((u) => (u.email ? [[`user://${u.id}`, u.email]] : [])));
  const [self] = (yield* decodeUsers(users)).results;
  if (!self) return yield* new McpFailure({ server: "notion", cause: "Notion did not return your user" });
  const me = `user://${self.id}`;
  // The view tool does not offer a proven cursor path here; disclose a possibly incomplete page.
  // Not cached: a reply should show on the next load. One view call plus one comments call per card.
  const queried = yield* decodeRows(
    yield* mcp.call("notion", "notion-query-data-sources", {
      data: { mode: "view", view_url: ROADMAP_VIEW, page_size: 100 },
    }),
  );
  yield* store.write(
    storeKey("coverage:notion-truncated", Schema.Boolean),
    queried.has_more === true || queried.results.length >= 100,
  );
  for (const raw of queried.results) {
    const normalized = notionProperties(raw);
    if (typeof normalized.Name !== "string" || typeof normalized.Status !== "string")
      return yield* new McpFailure({
        server: "notion",
        cause: "Configured title or status column is missing from the selected view. Check Settings.",
      });
  }
  const rows = queried.results.flatMap((r) => {
    const row = decodeRow(notionProperties(r));
    if (Option.isNone(row) || !OPEN.includes(row.value.Status)) return [];
    const mine = [row.value.Assign, row.value.Reviewer].some((people) => people !== undefined && people.includes(me));
    return mine ? [row.value] : [];
  });

  // Each card's tickets as last built, for when Linear cannot say what a ticket is right now.
  const before = new Map(((yield* store.read(ROADMAP_KEY))?.value ?? []).map((c) => [c.id, c.tickets]));
  const cards = yield* Effect.forEach(
    rows,
    (row) =>
      Effect.gen(function* () {
        const id = pageId(row.url);
        if (!id) return [];
        const owner = row.Assign !== undefined && row.Assign.includes(me);
        const comments = yield* mcp
          .call("notion", "notion-get-comments", { page_id: id, include_all_blocks: true })
          .pipe(
            Effect.flatMap(decodeComments),
            Effect.map(({ text }) => (text === undefined ? "" : text)),
            Effect.catch((error) =>
              Effect.logWarning(`Could not read Notion comments on ${row.Name}.`, error).pipe(Effect.as("")),
            ),
          );
        const reply = notionReply(parseDiscussions(comments), self.id, owner);
        // Yours while scoping; someone else's only once it is ready for your review. A reply always shows.
        const needsYou = owner ? SCOPING.includes(row.Status) : row.Status === READY_TO_REVIEW;
        if (!needsYou && !reply) return [];
        // The doc's own text, for the Slack threads and the tickets it names.
        const page = yield* cardPage(id);
        const card: RoadmapCard = {
          id,
          url: notionHref(row.url, row.Name),
          name: row.Name,
          status: row.Status,
          priority: row.Priority,
          role: owner ? "owner" : "reviewer",
          reply: reply && { ...reply, url: notionHref(reply.url, row.Name) },
          sessions: [],
          reviewers: (row.Reviewer ? row.Reviewer : []).flatMap((id) => {
            const email = emailById.get(id);
            return email && email !== self.email ? [email] : [];
          }),
          slack: enabled("slack") ? yield* cardThreads(page, workspace) : [],
          tickets: [],
        };
        const owners = (row.Assign ?? []).flatMap((person) => {
          const email = emailById.get(person);
          return email ? [displayName(email)] : [];
        });
        return [{ card, page, owners }];
      }),
    { concurrency: 3 },
  );
  // One Linear lookup for the tickets every card names.
  const issues = yield* issuesById(cards.flat().flatMap(({ page }) => [...docMentions(page, CONTEXT).keys()])).pipe(
    Effect.result,
  );
  if (Result.isFailure(issues))
    yield* Effect.logWarning(
      "Could not read the tickets on the Roadmap cards; keeping their last state.",
      issues.failure,
    );
  const shown = yield* Effect.forEach(
    cards.flat(),
    ({ card, page, owners }) =>
      cardTickets(
        page,
        { id: card.id, name: card.name, status: card.status, owners },
        before.get(card.id) ?? [],
        issues,
      ).pipe(Effect.map((tickets): RoadmapCard => ({ ...card, tickets }))),
    { concurrency: 3 },
  );
  // A session belongs to a card if it mentions the card's page, and Jev agrees. Searched back 90 days: scoping takes weeks.
  const items = shown.map((c): WorkItem => ({
    key: `card-${c.id}`,
    kind: "Notion Roadmap card",
    title: c.name,
    status: c.status,
    refs: [`notion:${c.id}`],
  }));
  const bySession = yield* matchSessions(items, yield* getSessionsMentioning(items.flatMap((i) => i.refs)));
  const withSessions = shown.map((c): RoadmapCard => {
    const found = bySession.get(`card-${c.id}`);
    return { ...c, sessions: found ? found : [] };
  });
  // Replies first, then Notion priority (none last).
  const rank = (c: RoadmapCard) => (c.reply ? 0 : 10) + (c.priority && PRIORITY[c.priority] ? PRIORITY[c.priority] : 4);
  return withSessions.toSorted((a, b) => rank(a) - rank(b));
});

export const ROADMAP_KEY = storeKey("roadmap:v9", Schema.Array(RoadmapCard));
// Notion has no push, so a reply on your doc reaches the Inbox with the next rebuild: with the minute's section refresh
// that is about every 3 minutes while you look, and every 15 minutes when nobody does.
export const ROADMAP_FRESH = Duration.minutes(2);

/** The cards as last built. Outside `ReadOnly`, ones older than ROADMAP_FRESH are rebuilt behind the answer. */
export const getRoadmapCards = Effect.fn("notion.getRoadmapCards")(function* () {
  if (!enabled("notion")) return [];
  const store = yield* Store;
  return yield* store.cached(ROADMAP_KEY, ROADMAP_FRESH, loadRoadmapCards);
});

/** Builds the cards now, for when a live check sees the Roadmap move. */
export const rebuildRoadmap = Effect.gen(function* () {
  const store = yield* Store;
  return yield* store.refresh(ROADMAP_KEY, loadRoadmapCards);
});
