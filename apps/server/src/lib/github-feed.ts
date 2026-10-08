import { enabled } from "../profile";
import { Duration, Effect, Schema } from "effect";
import { getReviewFeed } from "@/lib/github";
import { countRefs, refKeys } from "@/lib/refs";
import { FeedPR, FeedReview, groupPRs, shareGroupSessions, Waiting } from "@/lib/review-feed";
import { matchSessions, ScoredSessions, type WorkItem } from "@/lib/session-match";
import { getSessionsMentioning } from "@/lib/sessions";
import { Store, storeKey } from "@/services/store";

/** A FeedPR from review-feed.ts, with what the Review column shows on it. */
export const ReviewItem = Schema.Struct({
  ...FeedPR.fields,
  waiting: Waiting,
  /** Open AI reviewer threads on it, and the people who have already reviewed it. */
  ai: Schema.NullOr(Schema.Struct({ count: Schema.Finite, url: Schema.String })),
  reviewedBy: Schema.Array(Schema.String),
  /** Your own last review, so an approval that still stands is visible. */
  yours: Schema.NullOr(FeedReview),
  sessions: ScoredSessions,
});
export type ReviewItem = typeof ReviewItem.Type;

/**
 * The Review column: other people's PRs waiting on you, grouped so one change across core, web, mobile-app
 * and admin-console reads as one thing. Each PR carries the agent sessions that reviewed it; a review session
 * usually starts with the PR link ("pr review this <url>"), sometimes several at once.
 */
export const ReviewFeed = Schema.Struct({
  groups: Schema.Array(Schema.Struct({ key: Schema.String, prs: Schema.Array(ReviewItem), waiting: Waiting })),
  seen: Schema.Array(Schema.String),
});
export type ReviewFeed = typeof ReviewFeed.Type;

/** Where the review feed lives in the store. */
export const FEED_KEY = storeKey("github:review-feed:v15", ReviewFeed);
// Rebuilt when the GitHub probe sees a change (live.ts); this is the backstop.
export const REVIEW_FRESH = Duration.minutes(10);

export const buildReviewFeed = Effect.fn("github-feed.buildReviewFeed")(function* () {
  const { prs: feed, seen } = yield* getReviewFeed();
  const items = feed.map((pr): WorkItem => ({
    key: pr.key,
    kind: "Pull request",
    title: pr.title,
    status: `${pr.waiting.need} (by ${pr.author})`,
    // Its own link, plus any ticket named in the title or branch, e.g. "(DEMO-3818)".
    refs: [
      ...refKeys(pr.url),
      ...Object.keys(countRefs(`${pr.title} ${pr.branch}`)).filter((k) => k.startsWith("ticket:")),
    ],
  }));
  const bySession = yield* matchSessions(items, yield* getSessionsMentioning(items.flatMap((i) => i.refs)));
  const result: ReviewFeed = {
    groups: groupPRs(
      feed.map((pr) => {
        const found = bySession.get(pr.key);
        return { ...pr, sessions: found ? found : [] };
      }),
    ).map(shareGroupSessions),
    seen,
  };
  return result;
});

/** Rebuilds the Review column now. */
export const rebuildReview = Effect.gen(function* () {
  const store = yield* Store;
  return yield* store.refresh(FEED_KEY, buildReviewFeed());
});
