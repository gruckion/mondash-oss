import { Schema } from "effect";
import { ChecksSummary } from "./github-checks.ts";
import { PRStack, PRChanges } from "@mondash/shared/contract";

// What another person's PR needs from you. No "@/" imports, so tests can import it.

const FeedComment = Schema.Struct({
  author: Schema.String,
  at: Schema.Date,
  url: Schema.String,
  isBot: Schema.Boolean,
});
const FeedThread = Schema.Struct({ isResolved: Schema.Boolean, comments: Schema.Array(FeedComment) });
export const FeedReview = Schema.Struct({
  author: Schema.String,
  state: Schema.String,
  at: Schema.Date,
  isBot: Schema.Boolean,
  /** Last inline comment in this review, or the review itself when it has no inline comments. */
  url: Schema.optional(Schema.String),
});
export type FeedReview = typeof FeedReview.Type;

export const FeedPR = Schema.Struct({
  key: Schema.String,
  /** Other PRs this one names in its description, as "web#1846", and any ticket IDs it names. */
  links: Schema.Array(Schema.String),
  tickets: Schema.Array(Schema.String),
  url: Schema.String,
  title: Schema.String,
  repo: Schema.String,
  author: Schema.String,
  branch: Schema.String,
  isDraft: Schema.Boolean,
  state: Schema.optional(Schema.Literals(["OPEN", "MERGED", "CLOSED"])),
  // APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED
  review: Schema.optional(Schema.NullOr(Schema.String)),
  checks: Schema.optional(Schema.NullOr(Schema.String)),
  checksSummary: Schema.optional(ChecksSummary),
  stack: Schema.optional(PRStack),
  aiCheckFailures: Schema.optional(Schema.Array(Schema.String)),
  changes: Schema.optional(PRChanges),
  createdAt: Schema.Date,
  lastCommitAt: Schema.Date,
  reviews: Schema.Array(FeedReview),
  threads: Schema.Array(FeedThread),
  /** Your review was asked for, by name or through your team, as the PR lists it now. */
  requested: Schema.Boolean,
  /** When you last said anything on it: a review, a comment, or a reply in a thread. */
  yourLastWordAt: Schema.optional(Schema.Date),
  /** When your review was last asked for. */
  requestedAt: Schema.optional(Schema.Date),
});
export type FeedPR = typeof FeedPR.Type;

/**
 * What you owe on someone else's PR, most urgent first:
 * - reply: they answered you in a thread you wrote in, and it is still open.
 * - rereview: you asked for changes or commented, and they have pushed since.
 * - review: your review was asked for and you have not reviewed.
 * Anything else needs nothing from you: you approved it, or the ball is with them.
 */
const Need = Schema.Literals(["reply", "rereview", "review"]);
type Need = typeof Need.Type;
export const Waiting = Schema.Struct({
  need: Need,
  at: Schema.Date,
  url: Schema.String,
  count: Schema.Finite,
  from: Schema.optional(Schema.Array(Schema.String)),
});
export type Waiting = typeof Waiting.Type;

const RANK: Record<Need, number> = { reply: 0, rereview: 1, review: 2 };

/** Your last review on it, or null. An approval still standing is worth seeing. */
export function yourReview(pr: FeedPR, me: string): FeedReview | null {
  const mine = pr.reviews.filter((r) => r.author === me).toSorted((a, b) => a.at.getTime() - b.at.getTime());
  const last = mine.at(-1);
  return last ? last : null;
}

export function waitingOnYou(pr: FeedPR, me: string): Waiting | null {
  const myThreads = pr.threads.filter((t) => t.comments.some((c) => c.author === me));
  const replies = myThreads.flatMap((t) => {
    const last = t.comments.at(-1);
    return !t.isResolved && last && last.author !== me ? [last] : [];
  });
  const [newest] = replies.toSorted((a, b) => b.at.getTime() - a.at.getTime());
  if (newest)
    return {
      need: "reply",
      at: newest.at,
      url: newest.url,
      count: replies.length,
      from: [...new Set(replies.map((r) => r.author))],
    };

  const last = yourReview(pr, me);
  if (!last) return pr.requested ? { need: "review", at: pr.createdAt, url: pr.url, count: 1 } : null;
  // They pushed after you last said anything, so what you approved is not what is there now.
  // A comment counts: "seen it, my review stands" is an answer, even though GitHub does not record it as a review.
  const yourLast = pr.yourLastWordAt && pr.yourLastWordAt > last.at ? pr.yourLastWordAt : last.at;
  if (pr.lastCommitAt > yourLast) return { need: "rereview", at: pr.lastCommitAt, url: pr.url, count: 1 };
  // They asked again after your last word. If you have answered since they asked, it is with them.
  if (pr.requested && pr.requestedAt && pr.requestedAt > yourLast)
    return { need: "review", at: pr.requestedAt, url: pr.url, count: 1 };
  return null;
}

// ponytail: a year-old PR in a personal repo is not this Monday's work; raise it if old reviews start going missing.
const STALE_DAYS = 30;

/** The feed: only PRs waiting on you, replies first, then pushes, then review requests, oldest first within each. */
export function reviewFeed(prs: FeedPR[], me: string, now = Date.now()): (FeedPR & { waiting: Waiting })[] {
  return prs
    .flatMap((pr) => {
      const waiting = waitingOnYou(pr, me);
      if (!waiting || pr.isDraft) return [];
      return now - waiting.at.getTime() < STALE_DAYS * 24 * 60 * 60 * 1000 ? [{ ...pr, waiting }] : [];
    })
    .toSorted((a, b) => RANK[a.waiting.need] - RANK[b.waiting.need] || a.waiting.at.getTime() - b.waiting.at.getTime());
}

/** The AI reviewers whose threads you are expected to fix, dismiss or resolve. */
export const AI_REVIEWERS = /^(coderabbitai|greptile-apps)$/;

/** Open threads where an AI reviewer spoke last, with a link to the first. */
export function aiThreads(pr: FeedPR): { count: number; url: string } | null {
  const open = pr.threads.filter((t) => !t.isResolved).flatMap((t) => t.comments.slice(-1));
  const ai = open.filter((c) => AI_REVIEWERS.test(c.author));
  const [first] = ai;
  return first ? { count: ai.length, url: first.url } : null;
}

/** People other than you and the author who have reviewed it, newest first. Bots do not count as a human review. */
export function humanReviewers(pr: FeedPR, me: string): string[] {
  const theirs = pr.reviews
    .filter((r) => !r.isBot && r.author !== me && r.author !== pr.author)
    .toSorted((a, b) => b.at.getTime() - a.at.getTime());
  return [...new Set(theirs.map((r) => r.author))];
}

/** A set of PRs that belong together: the same change across core, web, mobile-app and admin-console. */
export type ReviewGroup<T extends FeedPR & { waiting: Waiting }> = { key: string; prs: T[]; waiting: Waiting };

/**
 * Groups PRs that name each other in their descriptions, or share a ticket ID.
 * Paired PRs almost always link to each other ("core#2278" in the web one), which is what makes this reliable
 * even when the branches and titles differ.
 */
export function groupPRs<T extends FeedPR & { waiting: Waiting }>(prs: T[]): ReviewGroup<T>[] {
  const group = new Map<string, string>(prs.map((pr) => [pr.key, pr.key]));
  const find = (key: string): string => {
    const parent = group.get(key);
    return parent === undefined || parent === key ? key : find(parent);
  };
  const join = (a: string, b: string) => {
    const [rootA, rootB] = [find(a), find(b)];
    if (rootA !== rootB) group.set(rootB, rootA);
  };
  const byTicket = new Map<string, string>();
  for (const pr of prs) {
    for (const link of pr.links) if (group.has(link)) join(pr.key, link);
    for (const ticket of pr.tickets) {
      const first = byTicket.get(ticket);
      if (first) join(first, pr.key);
      else byTicket.set(ticket, pr.key);
    }
  }
  const grouped = Map.groupBy(prs, (pr) => find(pr.key));
  return [...grouped]
    .map(([key, members]) => {
      const prs = members.toSorted(
        (a, b) => RANK[a.waiting.need] - RANK[b.waiting.need] || a.waiting.at.getTime() - b.waiting.at.getTime(),
      );
      return { key, prs, waiting: prs[0].waiting };
    })
    .toSorted((a, b) => RANK[a.waiting.need] - RANK[b.waiting.need] || a.waiting.at.getTime() - b.waiting.at.getTime());
}

/** One change is reviewed together; keep each session's strongest approval, relevance before activity. */
export function shareGroupSessions<
  S extends { id: string; updatedAt: Date; jev?: number },
  T extends FeedPR & { waiting: Waiting; sessions: S[] },
>(group: ReviewGroup<T>): ReviewGroup<T> {
  if (group.prs.length < 2) return group;
  const ranked = group.prs
    .flatMap((pr) => pr.sessions)
    .toSorted((a, b) => (b.jev ?? 0) - (a.jev ?? 0) || b.updatedAt.getTime() - a.updatedAt.getTime());
  const unique = new Map<string, S>();
  for (const session of ranked) if (!unique.has(session.id)) unique.set(session.id, session);
  const sessions = [...unique.values()];
  return { ...group, prs: group.prs.map((pr) => ({ ...pr, sessions })) };
}

export type ReviewerState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "OTHER";

/**
 * Other reviewers grouped by what their latest review said (approved, asked for changes, commented), so a blocking
 * review never reads like an approval. In that order; empty when no one else has reviewed.
 */
export function reviewerStates(
  pr: Pick<FeedPR, "reviews"> & { reviewedBy: ReadonlyArray<string> },
): { state: ReviewerState; reviewers: { login: string; url?: string }[] }[] {
  const byState = new Map<ReviewerState, { login: string; url?: string }[]>();
  for (const login of pr.reviewedBy) {
    const latest = pr.reviews
      .filter((r) => r.author === login)
      .reduce<FeedReview | undefined>((last, r) => (!last || r.at > last.at ? r : last), undefined);
    const state: ReviewerState =
      latest && (latest.state === "APPROVED" || latest.state === "CHANGES_REQUESTED" || latest.state === "COMMENTED")
        ? latest.state
        : "OTHER";
    byState.set(state, [...(byState.get(state) ?? []), { login, url: latest?.url }]);
  }
  return (["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "OTHER"] as const).flatMap((state) => {
    const reviewers = byState.get(state);
    return reviewers ? [{ state, reviewers }] : [];
  });
}
