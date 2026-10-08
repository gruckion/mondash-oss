import type { Badge, ChecksSummary } from "./contract";

export type ReviewState = "rereview";
export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";
export type RingTone = "passed" | "pending" | "failed" | "skipped" | "cancelled" | "unreviewed";
export type ChecksRing =
  | { kind: "tick" }
  | { kind: "cross" }
  | { kind: "cancelled" }
  | { kind: "ring"; slots: { tone: RingTone; count: number }[] };

export function isAIReviewBadge(badge: Badge) {
  return /^[1-9]\d* AI review threads?$/i.test(badge.text);
}

const isDecision = (value: string | undefined): value is ReviewDecision =>
  value === "APPROVED" || value === "CHANGES_REQUESTED" || value === "REVIEW_REQUIRED";

/** A push since your review. The PR's overall approval is a slot in the checks ring. */
export function prReviewState(status: string | undefined, badges: readonly Badge[]): ReviewState | undefined {
  const has = (pattern: RegExp) => badges.some(({ text }) => pattern.test(text));
  if (status === "Updated since your review" || has(/^pushed since your review$/i)) return "rereview";
  return undefined;
}

/** GitHub's reviewDecision. PR cards and rows carry it as their status; drafts and older caches only as a badge. */
export function prReviewDecision(
  decision: string | undefined,
  status: string | undefined,
  badges: readonly Badge[],
): ReviewDecision | undefined {
  if (isDecision(decision)) return decision;
  if (isDecision(status)) return status;
  const has = (pattern: RegExp) => badges.some(({ text }) => pattern.test(text));
  if (has(/^changes requested$/i)) return "CHANGES_REQUESTED";
  if (has(/^approved$/i)) return "APPROVED";
  if (has(/^needs review$/i)) return "REVIEW_REQUIRED";
  return undefined;
}

/**
 * Merge readiness, like GitHub's own ring: one slot per check plus one for the review.
 * A tick means CI passed and nothing is waiting on a review; a cross means CI failed.
 */
export function checksRing(
  checks: string | undefined,
  summary: ChecksSummary | undefined,
  review: ReviewDecision | undefined,
): ChecksRing | undefined {
  const reported = summary
    ? summary.passed + summary.failed + summary.pending + summary.skipped + (summary.cancelled ?? 0)
    : 0;
  // Older cached responses only know the aggregate state: one slot stands for all of it.
  const counts =
    summary && reported
      ? { ...summary, cancelled: summary.cancelled ?? 0 }
      : {
          passed: checks === "SUCCESS" ? 1 : 0,
          pending: checks === "PENDING" ? 1 : 0,
          failed: checks === "FAILURE" || checks === "ERROR" ? 1 : 0,
          skipped: 0,
          cancelled: checks === "CANCELLED" ? 1 : 0,
        };
  // GitHub still waits on checks that have not reported yet.
  if (checks === "PENDING" && !counts.pending) counts.pending = 1;
  if (!counts.pending && counts.failed) return { kind: "cross" };
  if (!counts.pending && counts.cancelled) return { kind: "cancelled" };
  if (!counts.pending && (counts.passed || review === "APPROVED") && (!review || review === "APPROVED"))
    return { kind: "tick" };
  const slots = [
    {
      tone: "passed" as const,
      count: counts.passed + (review === "APPROVED" ? 1 : 0),
    },
    { tone: "pending" as const, count: counts.pending },
    {
      tone: "failed" as const,
      count: counts.failed + (review === "CHANGES_REQUESTED" ? 1 : 0),
    },
    { tone: "skipped" as const, count: counts.skipped },
    { tone: "cancelled" as const, count: counts.cancelled },
    {
      tone: "unreviewed" as const,
      count: review === "REVIEW_REQUIRED" ? 1 : 0,
    },
  ].filter((slot) => slot.count > 0);
  return slots.length ? { kind: "ring", slots } : undefined;
}

export function hasPRConflicts(badges: readonly Badge[]) {
  return badges.some(({ text }) => /^(?:merge )?conflicts$/i.test(text));
}

export function prFooterBadges(badges: readonly Badge[]) {
  return badges.filter(
    (badge) =>
      !isAIReviewBadge(badge) &&
      !/^(draft|open|closed|merged|approved|changes requested|needs (?:your )?review|pushed since your review|(?:merge )?conflicts|no one else yet|(?:approved|changes requested|commented|reviewed) by .+|you (?:approved|asked for changes|commented)|[✓✗●] checks(?: .*)?)$/i.test(
        badge.text,
      ),
  );
}

/** The full story behind the ring, one line per part, for its tooltip and screen readers. */
export function checksDetails(
  checks: string | undefined,
  summary: ChecksSummary | undefined,
  review: ReviewDecision | undefined,
): string[] {
  const counts = summary
    ? [
        summary.passed ? `${summary.passed} passed` : "",
        summary.pending ? `${summary.pending} pending` : "",
        summary.failed ? `${summary.failed} failed` : "",
        summary.skipped ? `${summary.skipped} skipped or neutral` : "",
        summary.cancelled ? `${summary.cancelled} cancelled` : "",
      ].filter(Boolean)
    : [];
  const ci = counts.length
    ? `Checks: ${counts.join(", ")}`
    : checks === "SUCCESS"
      ? "All checks passed"
      : checks === "FAILURE" || checks === "ERROR"
        ? "Checks failing"
        : checks === "PENDING"
          ? "Checks running"
          : checks === "CANCELLED"
            ? "Checks cancelled"
            : "No checks";
  const approval =
    review === "APPROVED"
      ? "Approved"
      : review === "CHANGES_REQUESTED"
        ? "Changes requested"
        : review === "REVIEW_REQUIRED"
          ? "Waiting for approval"
          : "";
  return [ci, approval].filter(Boolean);
}
