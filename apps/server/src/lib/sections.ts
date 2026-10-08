import { enabled } from "../profile";
import { Clock, Duration, Effect } from "effect";
import type { Card, Group, Person, SectionName, SectionResponse } from "@mondash/shared/contract";
import { Claude } from "@/services/claude";
import { issuesById } from "@/lib/linear-api";
import { Store, type StoreFailure } from "@/services/store";
import { getResume, RESUME_FRESH, RESUME_KEY, type ActiveTicket } from "@/lib/resume";
import { getRoadmapCards, ROADMAP_FRESH, ROADMAP_KEY } from "@/lib/notion";
import { buildReviewFeed, FEED_KEY, REVIEW_FRESH } from "@/lib/github-feed";
import { getRecentSessions, RECENT_FRESH, RECENT_KEY } from "@/lib/sessions";
import {
  inboxGroups,
  issueGroups,
  scopingGroups,
  reviewGroups,
  sessionGroups,
  withSessionContext,
  ticketRow,
  webLink,
} from "@/lib/presenters";
import { FEED_FRESH, FEED_KEY as FEED_KEY_INBOX, getFeedWithReads, INBOX_SOURCES, readState } from "@/lib/feed";
import { enrichTicketRows } from "@/lib/ticket-rows";
import { enrichNotionRows } from "@/lib/notion-rows";
import { notionDoc } from "@/lib/notion-doc";
import { attachReviewSessions } from "@/lib/review-sessions";
import type { ThreadSnapshot } from "@/lib/thread-discovery";
import { avatar } from "@/lib/slack-web";
import { PEOPLE, displayName } from "@/lib/people";
import { recordActivitySection } from "@/lib/activity";
import { sessionPRStatuses } from "@/lib/session-pr-statuses";

/** Every person on a card, wherever the card shows a face. */
const peopleOn = (card: Card): readonly Person[] => [
  ...(card.author ? [card.author] : []),
  ...(card.people ?? []),
  ...(card.assigned?.people ?? []),
  ...(card.badges ?? []).flatMap((badge) => badge.people ?? []),
  ...(card.rows ?? []).flatMap((row) => [
    ...(row.owner ? [row.owner] : []),
    ...(row.assignees ?? []),
    ...(row.reviewers ?? []),
    ...(row.badges ?? []).flatMap((badge) => badge.people ?? []),
  ]),
];

/** Adds Slack faces to the people who have none, looking each person up once; provider IDs stay on the Mac. */
const withAvatars = Effect.fnUntraced(function* (groups: readonly Group[]) {
  if (!enabled("slack")) return groups;
  const names = new Set(
    groups
      .flatMap((group) => group.cards.flatMap(peopleOn))
      .filter((p) => !p.avatar)
      .map((p) => p.name),
  );
  const faces = new Map<string, string>();
  yield* Effect.forEach(
    names,
    (name) =>
      Effect.gen(function* () {
        const matches = PEOPLE.filter(
          (candidate) => displayName(candidate.email || candidate.github || candidate.slack) === name,
        );
        const known = matches.length === 1 ? matches[0] : undefined;
        const url = known?.slack ? yield* avatar(known.slack) : undefined;
        const link = url ? webLink(url) : undefined;
        if (link) faces.set(name, link);
      }),
    { concurrency: "unbounded", discard: true },
  );
  const face = (person: Person): Person => {
    const url = person.avatar ? undefined : faces.get(person.name);
    return url ? { ...person, avatar: url } : person;
  };
  const faced = <T extends { people?: readonly Person[] }>(item: T): T =>
    item.people ? { ...item, people: item.people.map(face) } : item;
  return groups.map((group) => ({
    ...group,
    cards: group.cards.map((card) => ({
      ...faced(card),
      ...(card.author ? { author: face(card.author) } : {}),
      ...(card.assigned ? { assigned: { ...card.assigned, people: card.assigned.people.map(face) } } : {}),
      ...(card.badges ? { badges: card.badges.map(faced) } : {}),
      ...(card.rows
        ? {
            rows: card.rows.map((row) => ({
              ...row,
              ...(row.owner ? { owner: face(row.owner) } : {}),
              ...(row.assignees ? { assignees: row.assignees.map(face) } : {}),
              ...(row.reviewers ? { reviewers: row.reviewers.map(face) } : {}),
              ...(row.badges ? { badges: row.badges.map(faced) } : {}),
            })),
          }
        : {}),
    })),
  }));
});

type Source = { readonly key: string; readonly fresh: Duration.Input };

/**
 * The store key each section is built from, and how long its data counts as fresh. `parts` are the keys it is built
 * from in turn: the section is as old as the oldest of them, so one source that stopped refreshing shows.
 */
const FRESHNESS: Record<SectionName, Source & { readonly parts?: ReadonlyArray<Source> }> = {
  issues: { key: RESUME_KEY.name, fresh: RESUME_FRESH },
  scoping: { key: ROADMAP_KEY.name, fresh: ROADMAP_FRESH },
  reviews: { key: FEED_KEY.name, fresh: REVIEW_FRESH },
  sessions: { key: RECENT_KEY.name, fresh: RECENT_FRESH },
  inbox: { key: FEED_KEY_INBOX.name, fresh: FEED_FRESH, parts: INBOX_SOURCES },
};

/**
 * Builds one section for the app. `threads` reads the Slack threads found for the Issues section; they are searched
 * for apart from the sections (lib/thread-discovery.ts).
 */
export const loadSection = Effect.fn("sections.loadSection")(function* (
  section: SectionName,
  threads: (tickets: ReadonlyArray<ActiveTicket>) => Effect.Effect<ThreadSnapshot, StoreFailure>,
) {
  const store = yield* Store;
  const source = FRESHNESS[section];
  const sources = [source, ...(source.parts ?? [])];
  // Capture before loading: stale-while-revalidate may finish just after returning old data.
  const before = yield* Effect.forEach(sources, (part) => store.storedAt(part.key));
  let threadsState: SectionResponse["threadsState"];
  let groups: Group[];
  switch (section) {
    case "issues": {
      if (!enabled("linear") && !enabled("github")) {
        groups = [];
        break;
      }
      const resume = yield* getResume();
      const discovery = enabled("slack")
        ? yield* threads(resume.sections.flatMap((group) => group.tickets))
        : { entries: [], state: "ready" as const };
      groups = issueGroups(resume, new Map(discovery.entries));
      threadsState = discovery.state;
      break;
    }
    case "scoping":
      groups = scopingGroups(yield* getRoadmapCards());
      break;
    case "reviews": {
      if (!enabled("github")) {
        groups = [];
        break;
      }
      const feed = yield* store.cached(FEED_KEY, REVIEW_FRESH, buildReviewFeed());
      groups = attachReviewSessions(
        reviewGroups(feed),
        enabled("sessions") ? yield* (yield* Claude).reviewLaunches : [],
      );
      break;
    }
    case "sessions": {
      const sessions = yield* getRecentSessions();
      groups = sessionGroups(sessions, yield* sessionPRStatuses(sessions));
      break;
    }
    case "inbox":
      groups = inboxGroups(yield* getFeedWithReads(), yield* readState());
      break;
  }
  const stored = yield* Effect.forEach(sources, (part, i) => {
    const at = before[i];
    return at ? Effect.succeed(at) : store.storedAt(part.key);
  });
  if (enabled("sessions") && section !== "sessions" && section !== "inbox")
    groups = withSessionContext(groups, yield* getRecentSessions());
  groups = visibleGroups(groups);
  if (!enabled("classification")) groups = withoutClassification(groups);
  if (enabled("linear"))
    groups = yield* enrichTicketRows(groups, (ids) =>
      issuesById(ids).pipe(Effect.map((found) => new Map([...found].map(([id, issue]) => [id, ticketRow(issue)])))),
    );
  if (enabled("notion")) groups = yield* enrichNotionRows(groups, notionDoc);
  const now = yield* Clock.currentTimeMillis;
  // A part not stored yet (a source that is not connected) does not count.
  const ages = sources.flatMap((part, i) => {
    const at = stored[i];
    return at ? [{ at: at.getTime(), fresh: Duration.toMillis(Duration.fromInputUnsafe(part.fresh)) }] : [];
  });
  const at = stored[0];
  const response: SectionResponse = {
    version: 1,
    section,
    generatedAt: new Date(now).toISOString(),
    updatedAt: at ? new Date(Math.min(...ages.map((age) => age.at))).toISOString() : null,
    stale: !at || ages.some((age) => now - age.at >= age.fresh),
    groups: yield* withAvatars(groups),
    ...(threadsState ? { threadsState } : {}),
  };
  yield* recordActivitySection(response).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Recording activity failed", cause)),
  );
  return response;
});

/** Explicitly disabled sources are hidden even when an older aggregate snapshot contains them. */
export function visibleGroups(groups: readonly Group[]): Group[] {
  if (
    ["github", "linear", "slack", "notion", "sessions"].every((name) =>
      enabled(name as "github" | "linear" | "slack" | "notion" | "sessions"),
    )
  )
    return [...groups];
  const rowEnabled = (kind: string) =>
    kind === "pr"
      ? enabled("github")
      : kind === "ticket"
        ? enabled("linear")
        : kind === "notion"
          ? enabled("notion")
          : kind === "slack"
            ? enabled("slack")
            : true;
  return groups
    .map((group) => ({
      ...group,
      cards: group.cards
        .filter((card) =>
          card.kind === "issue"
            ? enabled("linear")
            : card.kind === "scoping"
              ? enabled("notion")
              : card.kind === "review"
                ? enabled("github")
                : card.kind === "session"
                  ? enabled("sessions")
                  : card.feedSource
                    ? enabled(card.feedSource)
                    : rowEnabled(card.kind),
        )
        .map((card) => ({
          ...card,
          ...(card.rows ? { rows: card.rows.filter((row) => rowEnabled(row.kind)) } : {}),
          ...(card.sessions && !enabled("sessions") ? { sessions: [] } : {}),
        })),
    }))
    .filter((group) => group.cards.length > 0);
}

/** Turning classification off also hides cached confidence and all automatic session associations. */
export function withoutClassification(groups: readonly Group[]): Group[] {
  const noScore = <A extends { jev?: number }>(value: A) => {
    const { jev: _score, ...rest } = value;
    return rest;
  };
  return groups.map((group) => ({
    ...group,
    cards: group.cards.map((card) => ({
      ...noScore(card),
      sessions: [],
      ...(card.badges ? { badges: card.badges.map(noScore) } : {}),
      ...(card.rows
        ? {
            rows: card.rows.map((row) => ({
              ...noScore(row),
              ...(row.badges ? { badges: row.badges.map(noScore) } : {}),
            })),
          }
        : {}),
    })),
  }));
}
