// Kept apart from feed.ts, which has "@/" imports, so the presenters and the tests can use them.
import { Schema } from "effect";
import type { FeedItem } from "./feed.ts";

/**
 * Direct: someone addressed you. Threads: a conversation you are in moved. Asks: someone needs you to act.
 * Saved: your Slack Later list, which never counts as unread.
 */
export type FeedTab = "direct" | "threads" | "asks" | "saved";
const TABS: Record<string, FeedTab> = {
  dm: "direct",
  mention: "direct",
  issueCommentMention: "direct",
  issueMention: "direct",
  thread_reply: "threads",
  comment: "threads",
  review: "threads",
  issueNewComment: "threads",
  review_requested: "asks",
  approved: "asks",
  changes_requested: "asks",
  issueAssignedToYou: "asks",
  saved: "saved",
};
/** Merges and status changes have no tab: they show under All only. */
export const feedTab = (item: Pick<FeedItem, "kind">): FeedTab | undefined => TABS[item.kind];

/** Your mark from the Inbox, and what the source said when you made it. */
export const Override = Schema.Struct({ read: Schema.Boolean, source: Schema.optional(Schema.Boolean) });
export type Override = typeof Override.Type;

/** Your mark holds until the source's own read state changes; then the source wins. */
export function isRead(override: Override | undefined, source: boolean | undefined, fallback: boolean): boolean {
  if (override && (source === undefined || source === override.source)) return override.read;
  return source ?? fallback;
}

/** One microsecond before a Slack timestamp: marking read up to there leaves the message itself unread. */
export function justBefore(ts: string): string {
  const [seconds, micros = "0"] = ts.split(".");
  // Whole microseconds fit safely in a double for Slack's ten-digit seconds.
  const total = Number(seconds) * 1_000_000 + Number(micros.padEnd(6, "0")) - 1;
  return `${Math.floor(total / 1_000_000)}.${String(total % 1_000_000).padStart(6, "0")}`;
}

export const DAY_GROUPS = ["Today", "Yesterday", "This week", "Earlier"] as const;
export type DayGroup = (typeof DAY_GROUPS)[number];

/** Which Inbox group a time falls in, by local calendar day: This week is the seven days before today. */
export function dayGroup(at: Date, now = new Date()): DayGroup {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(now) - day(at)) / (24 * 60 * 60 * 1000));
  return diff <= 0 ? "Today" : diff === 1 ? "Yesterday" : diff < 7 ? "This week" : "Earlier";
}
