import { useSection } from "@/lib/provider";
import type { Card, Group, SectionResponse } from "@mondash/shared/contract";
import { DashboardScreen } from "./dashboard-screen";

const TABS: [string, Card["feedTab"], string][] = [
  ["All", undefined, "All incoming activity, excluding your saved items."],
  ["Direct", "direct", "Direct messages and mentions addressed to you."],
  ["Threads", "threads", "Replies and activity in your conversations."],
  ["Asks", "asks", "Review requests, approvals, requested changes, and issues assigned to you."],
  ["Saved", "saved", "Your Slack Later items; completed items are folded under Done."],
];

/** Unread and meant for you. Saved is your Slack Later list, so it never counts. */
const needsYou = (card: Card) => !!card.unread && !!card.feedTab && card.feedTab !== "saved";

// Split by what is asked of you, not by app; each tab's number is what is still unread in it,
// except Saved, which shows how many you have.
const pages = (groups: readonly Group[]) =>
  TABS.map(([title, tab, description]) => {
    const kept = groups
      .map((group) => ({
        ...group,
        // All is what came in; Saved is your Later list and stays in its own tab.
        cards: group.cards.filter((card) => (tab ? card.feedTab === tab : card.feedTab !== "saved")),
      }))
      .filter((group) => group.cards.length);
    if (tab === "saved") {
      // Items Jev judged done (their tickets closed, or it no longer needs you) fold away at the bottom.
      const open = kept
        .map((group) => ({
          ...group,
          cards: group.cards.filter((c) => !c.done),
        }))
        .filter((group) => group.cards.length);
      const done = kept.flatMap((group) => group.cards.filter((c) => c.done));
      return {
        title,
        description,
        groups: done.length ? [...open, { id: "done", title: "Done", collapsed: true, cards: done }] : open,
        count: open.reduce((sum, group) => sum + group.cards.length, 0),
        folded: ["done"],
      };
    }
    return {
      title,
      description,
      groups: kept,
      count: kept.flatMap((g) => g.cards).filter(needsYou).length,
    };
  });

export function InboxScreen() {
  return <DashboardScreen section="inbox" pages={pages} />;
}

const unread = (inbox: SectionResponse) => inbox.groups.flatMap((group) => group.cards).filter(needsYou).length;

/** How many Inbox items are unread and meant for you, for the badge on the Inbox button. */
export function useInboxUnread() {
  return useSection("inbox", unread).data ?? 0;
}
