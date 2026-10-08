// SVG strings for a PR's status icons, drawn the same on the web and the iPhone. No React, so both can use them.
import type { ChecksSummary } from "./contract";
import { checksRing, type ReviewDecision } from "./pr-presentation";

export type PRState = "OPEN" | "DRAFT" | "MERGED" | "CLOSED";
/** The two theme greys: skipped checks and a review still to come. */
export type IconGreys = { secondary: string; unreviewed: string };

const GREEN = "#3fb950";
const AMBER = "#d29922";
const RED = "#f85149";

const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">${body}</svg>`;
const line = (path: string, color: string) =>
  `<path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;

export const PR_STATE_TIPS: Record<PRState, string> = {
  OPEN: "Open pull request",
  DRAFT: "Draft pull request",
  MERGED: "Merged",
  CLOSED: "Closed without merging",
};

/** GitHub's pull request glyph in its state colour; a draft is dashed and grey. */
export function prStateSvg(state: PRState, greys: IconGreys): string {
  const color = state === "MERGED" ? "#a371f7" : state === "CLOSED" ? RED : state === "DRAFT" ? greys.secondary : GREEN;
  const nodes = '<circle cx="5" cy="4" r="2"/><circle cx="5" cy="16" r="2"/>';
  const body =
    state === "MERGED"
      ? `${nodes}<circle cx="15" cy="4" r="2"/><path d="M5 6v8M15 6c0 5-10 3-10 8"/>`
      : state === "CLOSED"
        ? `${nodes}<path d="M5 6v8M12 6l6 6M18 6l-6 6"/>`
        : `${nodes}<circle cx="15" cy="16" r="2"/><path d="M5 6v8M15 14V8c0-3-2-4-5-4M12 2l-2 2 2 2"${state === "DRAFT" ? ' stroke-dasharray="2 2"' : ""}/>`;
  return svg(
    `<g fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</g>`,
  );
}

/**
 * Merge readiness: a tick when CI passed and nothing waits on a review, a cross when CI failed, else a ring with an
 * arc per check and one for the review. Undefined when there is nothing to show.
 */
export function checksSvg(
  checks: string | undefined,
  summary: ChecksSummary | undefined,
  review: ReviewDecision | undefined,
  greys: IconGreys,
): string | undefined {
  const ring = checksRing(checks, summary, review);
  if (!ring) return undefined;
  if (ring.kind === "tick") return svg(line("M4 10l4 4 8-9", GREEN));
  if (ring.kind === "cross") return svg(line("M5 5l10 10M15 5L5 15", RED));
  if (ring.kind === "cancelled")
    return svg(
      line("M6.5 2h7L18 6.5v7L13.5 18h-7L2 13.5v-7Z", greys.secondary) +
        line("M10 6v5", greys.secondary) +
        `<circle cx="10" cy="14" r="1" fill="${greys.secondary}"/>`,
    );
  const colors = {
    passed: GREEN,
    pending: AMBER,
    failed: RED,
    skipped: greys.secondary,
    cancelled: greys.secondary,
    unreviewed: greys.unreviewed,
  };
  const total = ring.slots.reduce((sum, slot) => sum + slot.count, 0);
  // Each arc is proportional to GitHub's whole-rollup count, never a guessed percentage.
  const circumference = 2 * Math.PI * 7;
  let offset = 0;
  return svg(
    ring.slots
      .map(({ tone, count }) => {
        const length = (count / total) * circumference;
        const circle = `<circle cx="10" cy="10" r="7" fill="none" stroke="${colors[tone]}" stroke-width="3" stroke-dasharray="${length} ${circumference}" stroke-dashoffset="${-offset}" transform="rotate(-90 10 10)"/>`;
        offset += length;
        return circle;
      })
      .join(""),
  );
}

export const rereviewSvg = svg(line("M17 8a7 7 0 1 0 0 5M17 3v5h-5", AMBER));
/** A blocked pull request. A colour override gives menu actions a monochrome version of the same glyph. */
export function conflictsSvg(state: PRState, greys: IconGreys, color = "#f0883e"): string {
  const draft = state === "DRAFT";
  return svg(
    `<g fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 1.5l5 5M7.5 1.5l-5 5M5 9v7"/><g stroke="${draft ? greys.secondary : color}"><path d="M11 4h1a3 3 0 0 1 3 3v7"${draft ? ' stroke-dasharray="2 2"' : ""}/><circle cx="15" cy="16" r="2"/></g></g>`,
  );
}
