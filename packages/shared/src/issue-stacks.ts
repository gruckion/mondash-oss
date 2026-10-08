import type { Card, Row, Session } from "./contract";
import { itemUrlKey } from "./linked-items";
import { slackThreadUrl } from "./slack-thread-url";
import { isOtherPR } from "./pr-rows";

export type IssueStack = { readonly cards: readonly Card[]; readonly prs: readonly Row[] };
export type IssueEntry = { readonly card: Card } | { readonly stack: IssueStack };
export const prIdentity = (row: Row) => itemUrlKey(row.url) ?? row.url;
const prsFor = (card: Card) => (card.rows ?? []).filter((row) => row.kind === "pr" && !isOtherPR(row));
export const hasStackPR = (card: Card, row: Row) => prsFor(card).some((pr) => prIdentity(pr) === prIdentity(row));
const at = (item: { readonly updatedAt?: string }) => (item.updatedAt ? Date.parse(item.updatedAt) : 0);
function newest<T extends { readonly updatedAt?: string }>(map: Map<string, T>, key: string, item: T) {
  const previous = map.get(key);
  if (!previous || at(item) > at(previous)) map.set(key, item);
}

/** Call after filtering/sorting, separately for each section. Every member must share one actual open PR. */
export function issueEntries(cards: readonly Card[], stacked: boolean): IssueEntry[] {
  if (!stacked) return cards.map((card) => ({ card }));
  const candidates = new Map<string, { members: Set<Card>; first: number }>();
  cards.forEach((card, index) => {
    if (card.kind !== "issue") return;
    prsFor(card).forEach((row) => {
      const key = prIdentity(row);
      const candidate = candidates.get(key) ?? { members: new Set<Card>(), first: index };
      candidate.members.add(card);
      candidates.set(key, candidate);
    });
  });
  const ordered = [...candidates.entries()].sort(
    ([ak, a], [bk, b]) => b.members.size - a.members.size || a.first - b.first || ak.localeCompare(bk),
  );
  const placed = new Set<Card>();
  const stacks = new Map<Card, IssueStack>();
  for (const [, candidate] of ordered) {
    const members = cards.filter((card) => candidate.members.has(card) && !placed.has(card));
    if (members.length < 2) continue;
    const prs = new Map<string, Row>();
    for (const card of members) {
      placed.add(card);
      // Keep each member's additional open and draft PRs.
      for (const row of prsFor(card)) newest(prs, prIdentity(row), row);
    }
    stacks.set(members[0], { cards: members, prs: [...prs.values()] });
  }
  return cards.flatMap((card): IssueEntry[] => {
    const stack = stacks.get(card);
    return stack ? [{ stack }] : placed.has(card) ? [] : [{ card }];
  });
}

/** Count a shared thread or session once, keeping its newest snapshot. Hermes-compatible and immutable. */
export function stackActivity(cards: readonly Card[]) {
  const threads = new Map<string, Row>();
  const sessions = new Map<string, Session>();
  const otherPRs = new Map<string, Row>();
  for (const card of cards) {
    for (const row of card.rows ?? []) {
      if (isOtherPR(row)) newest(otherPRs, prIdentity(row), row);
      if (row.kind !== "slack") continue;
      const url = new URL(slackThreadUrl(row.url));
      const channel = url.pathname.match(/^\/archives\/([CDG][A-Z0-9]+)\/p\d{16}\/?$/)?.[1];
      const thread = url.searchParams.get("thread_ts");
      const key = channel && thread && /^\d{10}\.\d{6}$/.test(thread) ? `${url.host}/${channel}/${thread}` : url.href;
      newest(threads, key, row);
    }
    for (const session of card.sessions) newest(sessions, `${session.tool}:${session.id}`, session);
  }
  return {
    threads: [...threads.values()].sort((a, b) => at(b) - at(a)),
    sessions: [...sessions.values()].sort((a, b) => at(b) - at(a)),
    otherPRs: [...otherPRs.values()].sort((a, b) => at(b) - at(a)),
  };
}
