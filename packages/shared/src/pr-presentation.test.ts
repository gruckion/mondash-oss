import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checksDetails,
  checksRing,
  hasPRConflicts,
  prFooterBadges,
  prReviewDecision,
  prReviewState,
} from "./pr-presentation.ts";
import type { Badge } from "./contract.ts";

const badge = (text: string): Badge => ({ text, tone: "neutral" });

test("cancelled checks use a cancellation warning and never imply a failure or success", () => {
  const cancelled = { passed: 4, failed: 0, pending: 0, skipped: 0, cancelled: 1 };
  assert.deepEqual(checksRing("CANCELLED", cancelled, "APPROVED"), { kind: "cancelled" });
  assert.deepEqual(checksRing("CANCELLED", undefined, undefined), { kind: "cancelled" });
  assert.deepEqual(checksRing("FAILURE", { ...cancelled, failed: 1 }, "APPROVED"), { kind: "cross" });
  assert.deepEqual(checksRing("PENDING", { ...cancelled, pending: 1 }, undefined), {
    kind: "ring",
    slots: [
      { tone: "passed", count: 4 },
      { tone: "pending", count: 1 },
      { tone: "cancelled", count: 1 },
    ],
  });
  assert.deepEqual(checksDetails("CANCELLED", cancelled, undefined), ["Checks: 4 passed, 1 cancelled"]);
  assert.deepEqual(checksDetails("CANCELLED", undefined, undefined), ["Checks cancelled"]);
});

test("a new push takes precedence over a previous approval", () => {
  assert.equal(prReviewState("APPROVED", [badge("pushed since your review"), badge("you approved")]), "rereview");
  assert.equal(prReviewState("Updated since your review", []), "rereview");
});

test("only a push since your review gets its own icon", () => {
  assert.equal(prReviewState("Review requested", [badge("you approved")]), undefined);
  assert.equal(prReviewState("REVIEW_REQUIRED", [badge("needs review")]), undefined);
  assert.equal(prReviewState("Reply waiting", [badge("you approved")]), undefined);
});

test("the ring tooltip spells out checks and approval", () => {
  assert.deepEqual(checksDetails("PENDING", { passed: 9, pending: 1, failed: 0, skipped: 2 }, "REVIEW_REQUIRED"), [
    "Checks: 9 passed, 1 pending, 2 skipped or neutral",
    "Waiting for approval",
  ]);
  assert.deepEqual(checksDetails("SUCCESS", undefined, "APPROVED"), ["All checks passed", "Approved"]);
  assert.deepEqual(checksDetails(undefined, undefined, undefined), ["No checks"]);
});

test("the PR's review decision comes from the field, its status, or an older badge", () => {
  assert.equal(prReviewDecision("APPROVED", "Review requested", []), "APPROVED");
  assert.equal(prReviewDecision(undefined, "REVIEW_REQUIRED", []), "REVIEW_REQUIRED");
  assert.equal(prReviewDecision(undefined, "Draft", [badge("changes requested")]), "CHANGES_REQUESTED");
  assert.equal(prReviewDecision(undefined, "Reply waiting", [badge("you approved")]), undefined);
});

test("the ring stays open until CI passes and the PR is approved", () => {
  const green = { passed: 9, pending: 0, failed: 0, skipped: 0 };
  assert.deepEqual(checksRing("SUCCESS", green, "REVIEW_REQUIRED"), {
    kind: "ring",
    slots: [
      { tone: "passed", count: 9 },
      { tone: "unreviewed", count: 1 },
    ],
  });
  assert.deepEqual(checksRing("SUCCESS", green, "APPROVED"), { kind: "tick" });
  assert.deepEqual(checksRing("SUCCESS", green, undefined), { kind: "tick" });
  assert.deepEqual(checksRing("SUCCESS", green, "CHANGES_REQUESTED"), {
    kind: "ring",
    slots: [
      { tone: "passed", count: 9 },
      { tone: "failed", count: 1 },
    ],
  });
  assert.deepEqual(checksRing("FAILURE", { ...green, failed: 1 }, "APPROVED"), {
    kind: "cross",
  });
  assert.deepEqual(checksRing(undefined, undefined, "APPROVED"), {
    kind: "tick",
  });
  assert.deepEqual(checksRing("SUCCESS", undefined, "REVIEW_REQUIRED"), {
    kind: "ring",
    slots: [
      { tone: "passed", count: 1 },
      { tone: "unreviewed", count: 1 },
    ],
  });
  assert.deepEqual(checksRing("PENDING", { ...green, passed: 3 }, "APPROVED"), {
    kind: "ring",
    slots: [
      { tone: "passed", count: 4 },
      { tone: "pending", count: 1 },
    ],
  });
  assert.equal(checksRing(undefined, undefined, undefined), undefined);
});

test("footer preserves linked replies, reviewers, personal review and unknown metadata", () => {
  const replies = {
    ...badge("reply from Morgan P"),
    url: "https://github.com/org/core/pull/1#discussion_r1",
  };
  const details = [replies, badge("DM from Bob"), badge("new provider detail")];
  assert.deepEqual(
    prFooterBadges([
      ...details,
      ...[
        "approved",
        "needs review",
        "pushed since your review",
        "conflicts",
        "draft",
        "✓ checks",
        "2 AI review threads",
        "no one else yet",
        "reviewed by Alice",
        "you approved",
      ].map(badge),
    ]),
    details,
  );
});

test("conflicts are detected for current and older cached payloads", () => {
  assert.equal(hasPRConflicts([badge("conflicts")]), true);
  assert.equal(hasPRConflicts([badge("Merge conflicts")]), true);
  assert.equal(hasPRConflicts([badge("reply from Alice")]), false);
});
