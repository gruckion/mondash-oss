// Run: node --test src/lib/review-feed.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aiThreads,
  groupPRs,
  humanReviewers,
  reviewFeed,
  shareGroupSessions,
  waitingOnYou,
  yourReview,
  type FeedPR,
} from "./review-feed.ts";

const said = (author: string, at: Date, url: string, isBot = false) => ({ author, at, url, isBot });
const reviewed = (author: string, state: string, at: Date, isBot = false) => ({ author, state, at, isBot });

const day = (n: number) => new Date(`2026-09-${String(n).padStart(2, "0")}T12:00:00Z`);
const pr = (over: Partial<FeedPR> = {}): FeedPR => ({
  key: "core#1",
  url: "https://github.com/o/core/pull/1",
  title: "Fix it",
  repo: "o/core",
  author: "riley",
  branch: "fix",
  isDraft: false,
  links: [],
  tickets: [],
  createdAt: day(1),
  lastCommitAt: day(1),
  reviews: [],
  threads: [],
  requested: false,
  ...over,
});

test("a review you were asked for waits on you until you review", () => {
  assert.equal(waitingOnYou(pr({ requested: true }), "me")?.need, "review");
  assert.equal(waitingOnYou(pr(), "me"), null, "not asked, not yours to do");
  const approved = pr({ reviews: [reviewed("me", "APPROVED", day(2))] });
  assert.equal(waitingOnYou(approved, "me"), null, "reviewed, nothing since");
});

test("their reply in your open thread comes back to you, and counts", () => {
  const threads = [
    { isResolved: false, comments: [said("me", day(2), "t1"), said("riley", day(3), "t1b")] },
    { isResolved: false, comments: [said("me", day(2), "t2"), said("riley", day(4), "t2b")] },
    { isResolved: true, comments: [said("me", day(2), "t3"), said("riley", day(5), "t3b")] },
    { isResolved: false, comments: [said("riley", day(5), "t4")] },
  ];
  const waiting = waitingOnYou(pr({ threads, reviews: [reviewed("me", "CHANGES_REQUESTED", day(2))] }), "me");
  assert.equal(waiting?.need, "reply");
  assert.equal(waiting?.count, 2, "resolved threads and threads you never wrote in do not count");
  assert.equal(waiting?.url, "t2b", "the newest reply is the link");
});

test("a push after your review asks for another look; before it does not", () => {
  const reviews = [reviewed("me", "CHANGES_REQUESTED", day(3))];
  assert.equal(waitingOnYou(pr({ reviews, lastCommitAt: day(4) }), "me")?.need, "rereview");
  assert.equal(waitingOnYou(pr({ reviews, lastCommitAt: day(2) }), "me"), null);
});

test("an approval does not end it: a later push or a fresh request brings it back", () => {
  const approved = [reviewed("me", "APPROVED", day(3))];
  assert.equal(
    waitingOnYou(pr({ reviews: approved, lastCommitAt: day(4) }), "me")?.need,
    "rereview",
    "you approved older code",
  );
  assert.equal(
    waitingOnYou(pr({ reviews: approved, lastCommitAt: day(2), requested: true, requestedAt: day(4) }), "me")?.need,
    "review",
    "they asked again after your review",
  );
  assert.equal(
    waitingOnYou(
      pr({ reviews: approved, lastCommitAt: day(2), requested: true, requestedAt: day(4), yourLastWordAt: day(5) }),
      "me",
    ),
    null,
    "you answered after they asked, even if only in a comment",
  );
  assert.equal(
    waitingOnYou(
      pr({ reviews: approved, lastCommitAt: day(5), requested: true, requestedAt: day(4), yourLastWordAt: day(6) }),
      "me",
    ),
    null,
    "your comment after their push counts as having looked",
  );
  assert.equal(waitingOnYou(pr({ reviews: approved, lastCommitAt: day(2) }), "me"), null, "approved and quiet since");
});

test("your own last review is reported, so an approval that still stands is visible", () => {
  assert.equal(
    yourReview(pr({ reviews: [reviewed("me", "COMMENTED", day(2)), reviewed("me", "APPROVED", day(4))] }), "me")?.state,
    "APPROVED",
  );
  assert.equal(yourReview(pr({ reviews: [reviewed("riley", "APPROVED", day(4))] }), "me"), null);
});

test("the feed drops drafts, stale PRs and ones needing nothing; replies first, then pushes, then requests", () => {
  const feed = reviewFeed(
    [
      pr({ key: "old", requested: true, createdAt: new Date("2024-08-24T12:00:00Z") }),
      pr({ key: "a", requested: true }),
      pr({ key: "b", reviews: [reviewed("me", "COMMENTED", day(3))], lastCommitAt: day(4) }),
      pr({
        key: "c",
        threads: [{ isResolved: false, comments: [said("me", day(2), "u"), said("riley", day(3), "v")] }],
      }),
      pr({ key: "d", requested: true, isDraft: true }),
      pr({ key: "e" }),
    ],
    "me",
    day(6).getTime(),
  );
  assert.deepEqual(
    feed.map((f) => f.key),
    ["c", "b", "a"],
    "a two-year-old request is not this Monday's work",
  );
});

test("open AI threads are counted apart from people's", () => {
  const threads = [
    { isResolved: false, comments: [said("coderabbitai", day(2), "a", true)] },
    { isResolved: false, comments: [said("greptile-apps", day(3), "b", true)] },
    { isResolved: true, comments: [said("coderabbitai", day(2), "c", true)] },
    { isResolved: false, comments: [said("vercel", day(2), "d", true)] },
    { isResolved: false, comments: [said("riley", day(2), "e")] },
  ];
  const ai = aiThreads(pr({ threads }));
  assert.equal(ai?.count, 2, "resolved ones, other bots and people do not count");
  assert.equal(ai?.url, "a");
  assert.equal(aiThreads(pr()), null);
});

test("a human review means someone other than you and the author looked at it", () => {
  const reviews = [
    reviewed("greptile-apps", "COMMENTED", day(2), true),
    reviewed("morgan-demo", "COMMENTED", day(3)),
    reviewed("riley", "APPROVED", day(4)),
    reviewed("riley", "COMMENTED", day(2)),
    reviewed("me", "COMMENTED", day(5)),
  ];
  assert.deepEqual(
    humanReviewers(pr({ author: "quinn-demo", reviews }), "me"),
    ["riley", "morgan-demo"],
    "newest first, once each, no bots, not you",
  );
  assert.deepEqual(
    humanReviewers(pr({ author: "quinn-demo", reviews: [reviewed("quinn-demo", "COMMENTED", day(3))] }), "me"),
    [],
    "the author is not a reviewer",
  );
});

test("PRs that name each other, or share a ticket, are one group", () => {
  const waiting = { need: "review" as const, at: day(2), url: "u", count: 1 };
  const prs = [
    { ...pr({ key: "web#1842", links: ["core#2267"] }), waiting },
    { ...pr({ key: "core#2267", links: ["web#1842"] }), waiting },
    { ...pr({ key: "core#9", tickets: ["DEMO-1"] }), waiting },
    { ...pr({ key: "web#9", tickets: ["DEMO-1"] }), waiting },
    { ...pr({ key: "core#7", links: ["some-other-repo#3"] }), waiting },
  ];
  const groups = groupPRs(prs).map((g) => g.prs.map((p) => p.key).toSorted());
  assert.deepEqual(groups.toSorted(), [["core#7"], ["core#9", "web#9"], ["core#2267", "web#1842"]].toSorted());
});

test("a group is as urgent as its most urgent PR", () => {
  const at = day(2);
  const prs = [
    { ...pr({ key: "core#1", links: ["web#1"] }), waiting: { need: "review" as const, at, url: "u", count: 1 } },
    { ...pr({ key: "web#1", links: ["core#1"] }), waiting: { need: "reply" as const, at, url: "v", count: 3 } },
  ];
  const [group] = groupPRs(prs);
  assert.equal(group.waiting.need, "reply");
  assert.deepEqual(
    group.prs.map((p) => p.key),
    ["web#1", "core#1"],
    "the one that needs most comes first",
  );
});

test("a session on one PR of a change shows on every PR of that change, newest first", () => {
  const session = (id: string, at: number) => ({ id, updatedAt: day(at) });
  const waiting = { need: "review" as const, at: day(1), url: "u", count: 1 };
  const core = { ...pr({ key: "core#1" }), waiting, sessions: [session("a", 2)] };
  const web = { ...pr({ key: "web#2" }), waiting, sessions: [session("b", 5), session("a", 2)] };
  const shared = shareGroupSessions({ key: "core#1", waiting, prs: [core, web] });
  assert.deepEqual(
    shared.prs.map((p) => p.sessions.map((s) => s.id)),
    [
      ["b", "a"],
      ["b", "a"],
    ],
  );
  const alone = { key: "core#1", waiting, prs: [core] };
  assert.equal(shareGroupSessions(alone), alone);
});

test("a shared change keeps the best per-item approval and ranks relevance before recency", () => {
  const relevant = { id: "relevant", updatedAt: day(2), jev: 0.95 };
  const recent = { id: "recent", updatedAt: day(4), jev: 0.75 };
  const result = shareGroupSessions({
    key: "change",
    waiting: { need: "review", at: day(1), count: 0, url: "url" },
    prs: [
      {
        ...pr({ key: "one" }),
        waiting: { need: "review" as const, at: day(1), count: 0, url: "url" },
        sessions: [relevant, recent],
      },
      {
        ...pr({ key: "two" }),
        waiting: { need: "review" as const, at: day(1), count: 0, url: "url" },
        sessions: [{ ...relevant, jev: 0.8 }],
      },
    ],
  });
  assert.deepEqual(
    result.prs[0].sessions.map((s) => [s.id, s.jev]),
    [
      ["relevant", 0.95],
      ["recent", 0.75],
    ],
  );
});
