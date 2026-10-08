// How each screen can be sorted, filtered and trimmed down, shared by the iPhone and the web. No React, and no
// toSorted: Hermes on the phone lacks it.
import type { Card, Group } from "./contract";
import { prReviewDecision } from "./pr-presentation";
import { issueStateRank } from "./issue-order";

export type ViewSection = "issues" | "scoping" | "reviews" | "inbox" | "sessions";

/** One screen's choices. An empty filter list means everything; `hidden` lists card parts switched off. */
export type ViewOptions = {
  readonly sort: string;
  readonly filters: Readonly<Record<string, readonly string[]>>;
  readonly hidden: readonly string[];
};
export const DEFAULT_VIEW: ViewOptions = {
  sort: "default",
  filters: {},
  hidden: [],
};

/** Older saved Sessions preferences acquire the archive default; an explicit empty selection means All. */
export function viewOptionsFor(section: ViewSection, saved: ViewOptions = DEFAULT_VIEW): ViewOptions {
  return section === "sessions" && saved.filters.archive === undefined
    ? { ...saved, filters: { ...saved.filters, archive: ["Not archived"] } }
    : saved;
}

type Sort = {
  key: string;
  title: string;
  compare?: (a: Card, b: Card) => number;
};
type Property = {
  key: string;
  title: string;
  values: (card: Card) => readonly string[];
  /** A switch that keeps this value when on, and clears the filter when off. */
  toggle?: { value: string; about: string };
};
/** `about` is what the switch hides, for the (i) beside it. */
type Display = { key: DisplayKey; title: string; about: string };

/** The parts of a card the Display menu can switch off. */
export type DisplayKey =
  | "details"
  | "labels"
  | "replies"
  | "linked"
  | "prs"
  | "merged"
  | "slack"
  | "sessions"
  | "none"
  | "reviewers"
  | "preview"
  | "jev";

const time = (value?: string) => (value ? Date.parse(value) : 0);
const newest = (pick: (card: Card) => string | undefined) => (a: Card, b: Card) => time(pick(b)) - time(pick(a));
// Linear's scale: 1 Urgent … 4 Low; 0 (no priority) goes last.
const priority = (a: Card, b: Card) => (a.priorityValue || 5) - (b.priorityValue || 5);
const issuePriority = (a: Card, b: Card) =>
  priority(a, b) || issueStateRank(a.statusType, a.status) - issueStateRank(b.statusType, b.status);
const title = (a: Card, b: Card) => a.title.localeCompare(b.title);
/** Cards with no author sort first. */
const authorName = (card: Card) => (card.author ? card.author.name : "");
const doc = (card: Card) => card.rows?.find((row) => row.kind === "notion" && row.url === card.url);

const STATUS: Property = {
  key: "status",
  title: "Status",
  values: (card) => (card.status ? [card.status] : []),
};
const PRIORITY: Property = {
  key: "priority",
  title: "Priority",
  values: (card) => [card.priority ?? "No priority"],
};

export const VIEW_CONFIG: Record<
  ViewSection,
  { title: string; sorts: Sort[]; properties: Property[]; display: Display[] }
> = {
  issues: {
    title: "Issues",
    sorts: [
      { key: "default", title: "Linear order", compare: issuePriority },
      { key: "priority", title: "Priority", compare: issuePriority },
      {
        key: "recent",
        title: "Recently assigned",
        compare: newest((card) => card.assigned?.at ?? card.updatedAt),
      },
      { key: "title", title: "Title", compare: title },
    ],
    // Tickets only: the Other page's PRs carry GitHub's review state as their status.
    properties: [
      {
        ...STATUS,
        values: (card) => (card.kind === "issue" ? STATUS.values(card) : []),
      },
      PRIORITY,
      { key: "label", title: "Label", values: (card) => card.labels },
    ],
    display: [
      {
        key: "details",
        title: "Status and priority",
        about: "The grey box under the title: status, priority, who assigned it, and badges.",
      },
      {
        key: "labels",
        title: "Labels",
        about: "Linear's label pills, such as Billing or Bug.",
      },
      {
        key: "replies",
        title: "Replies",
        about: "The amber tab when someone has replied to you on the ticket.",
      },
      {
        key: "linked",
        title: "Notion docs",
        about: "Notion docs linked to the ticket.",
      },
      {
        key: "prs",
        title: "Pull requests",
        about: "Open pull requests for the ticket, with their checks.",
      },
      {
        key: "merged",
        title: "Other PRs",
        about: "The Other PRs row, which opens merged and closed pull requests in a sheet.",
      },
      {
        key: "slack",
        title: "Slack threads",
        about: "The Slack threads row: discussions linked to the ticket.",
      },
      {
        key: "sessions",
        title: "Agent sessions",
        about: "The Agent sessions row: Claude Code and Codex sessions on this work.",
      },
      {
        key: "none",
        title: "Missing links",
        about: "The grey None markers that say a ticket has no Slack thread, PR or agent session yet.",
      },
    ],
  },
  scoping: {
    title: "Scoping",
    sorts: [
      { key: "default", title: "Roadmap order" },
      { key: "priority", title: "Priority", compare: priority },
      {
        key: "edited",
        title: "Recently edited",
        compare: newest((card) => doc(card)?.updatedAt),
      },
      {
        key: "created",
        title: "Recently created",
        compare: newest((card) => doc(card)?.createdAt),
      },
    ],
    properties: [STATUS, PRIORITY],
    display: [
      {
        key: "details",
        title: "Status, priority and people",
        about: "The grey box: status, priority, estimate, assignees and reviewers.",
      },
      {
        key: "replies",
        title: "Replies",
        about: "The amber tab when someone has replied to you on the doc.",
      },
      {
        key: "linked",
        title: "Linear tickets",
        about: "Linear tickets the doc names, with Jev's score for how sure it is they are this card's work.",
      },
      {
        key: "slack",
        title: "Slack threads",
        about: "The Slack threads row: threads the doc links to.",
      },
      {
        key: "sessions",
        title: "Agent sessions",
        about: "The Agent sessions row: Claude Code and Codex sessions on this card.",
      },
      {
        key: "none",
        title: "Missing links",
        about: "The grey None markers that say a card has no Slack thread, ticket or agent session yet.",
      },
    ],
  },
  reviews: {
    title: "Reviews",
    sorts: [
      { key: "default", title: "Waiting on you" },
      {
        key: "recent",
        title: "Most recent",
        compare: newest((card) => card.updatedAt),
      },
      {
        key: "oldest",
        title: "Oldest first",
        compare: (a, b) => time(a.updatedAt) - time(b.updatedAt),
      },
      {
        key: "author",
        title: "Author",
        compare: (a, b) => authorName(a).localeCompare(authorName(b)),
      },
    ],
    properties: [
      { key: "waiting", title: "Waiting for", values: (card) => [card.status] },
      {
        key: "author",
        title: "Author",
        values: (card) => (card.author ? [card.author.name] : []),
      },
      {
        key: "repo",
        title: "Repository",
        values: (card) => (card.prKey ? [card.prKey.split("#")[0]] : []),
      },
      {
        key: "approval",
        title: "Hide approved PRs",
        toggle: {
          value: "Not approved",
          about: "Hide PRs with an approval from you or another person, even if more reviews are still required.",
        },
        values: (card) => [
          prReviewDecision(card.reviewDecision, card.status, card.badges ?? []) === "APPROVED" ||
          card.badges?.some(({ text }) => /^(?:approved by .+|you approved)$/i.test(text))
            ? "Approved"
            : "Not approved",
        ],
      },
    ],
    display: [
      {
        key: "reviewers",
        title: "Reviewers and AI reviews",
        about: "Who else has reviewed the PR, and open CodeRabbit or Greptile threads.",
      },
      {
        key: "linked",
        title: "Linear tickets",
        about: "The Linear tickets the PR is for.",
      },
      {
        key: "sessions",
        title: "Agent sessions",
        about: "The Agent sessions row: sessions reviewing this PR.",
      },
      {
        key: "none",
        title: "Missing links",
        about: "The grey None markers for missing Slack threads or tickets. The Review button always shows.",
      },
    ],
  },
  inbox: {
    title: "Inbox",
    sorts: [
      { key: "default", title: "Newest first" },
      {
        key: "oldest",
        title: "Oldest first",
        compare: (a, b) => time(a.updatedAt) - time(b.updatedAt),
      },
      {
        key: "unread",
        title: "Unread first",
        compare: (a, b) => Number(!!b.unread) - Number(!!a.unread),
      },
    ],
    properties: [
      {
        key: "source",
        title: "Source",
        values: (card) => (card.feedSource ? [card.feedSource[0].toUpperCase() + card.feedSource.slice(1)] : []),
      },
      {
        key: "read",
        title: "Read",
        values: (card) => [card.unread ? "Unread" : "Read"],
      },
    ],
    display: [
      {
        key: "preview",
        title: "Message preview",
        about: "The start of the message, under each title.",
      },
      {
        key: "jev",
        title: "Jev scores",
        about: "Jev's chance that a saved item still needs you.",
      },
    ],
  },
  sessions: {
    title: "Sessions",
    sorts: [
      { key: "default", title: "Most recent" },
      {
        key: "oldest",
        title: "Oldest first",
        compare: (a, b) => time(a.updatedAt) - time(b.updatedAt),
      },
      { key: "title", title: "Title", compare: title },
    ],
    properties: [
      { key: "tool", title: "Tool", values: (card) => [card.subtitle] },
      {
        key: "archive",
        title: "Archive status",
        values: (card) => [card.sessions.some((session) => session.archived) ? "Archived" : "Not archived"],
      },
    ],
    display: [
      {
        key: "preview",
        title: "Recap or last reply",
        about: "Claude's recap of the session, or its last reply when there is no recap.",
      },
    ],
  },
};

/**
 * Each property's values across the cards, most common first, with how many cards have each and one such card, so
 * the menu can draw the value as the cards do (a status icon, priority bars, a label's colour).
 */
export function propertyValues(section: ViewSection, key: string, groups: readonly Group[]) {
  const property = VIEW_CONFIG[section].properties.find((p) => p.key === key);
  if (!property) return [];
  const found = new Map<string, { value: string; count: number; card: Card }>();
  for (const card of groups.flatMap((group) => group.cards))
    for (const value of new Set(property.values(card))) {
      const seen = found.get(value);
      if (seen) seen.count += 1;
      else found.set(value, { value, count: 1, card });
    }
  return [...found.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

export const isFiltered = (options: ViewOptions) => Object.values(options.filters).some((values) => values.length > 0);

/**
 * The groups with the screen's filters and sort applied. A card stays when, for every filtered property, it has one
 * of the chosen values. Sorting is within each group; Reviews' groups (a PR, or a PR pair) sort by their first card.
 */
export function applyView(section: ViewSection, groups: readonly Group[], options: ViewOptions): readonly Group[] {
  const config = VIEW_CONFIG[section];
  const active = config.properties.filter((p) => options.filters[p.key]?.length);
  const keep = (card: Card) =>
    active.every((p) => p.values(card).some((value) => options.filters[p.key].includes(value)));
  const compare = config.sorts.find((s) => s.key === options.sort)?.compare;
  const filtered = groups.map((group) => {
    const cards = group.cards.filter(keep);
    return { ...group, cards: compare ? [...cards].sort(compare) : cards };
  });
  if (!compare || !filtered.every((group) => ["review-group", "review-stack"].includes(group.presentation ?? "")))
    return filtered;
  return [...filtered].sort((a, b) => (a.cards[0] && b.cards[0] ? compare(a.cards[0], b.cards[0]) : 0));
}
