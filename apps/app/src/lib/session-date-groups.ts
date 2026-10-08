import type { Group } from "@mondash/shared/contract";

/** Calendar dates in the viewer's timezone; subtracting 24 hours breaks across daylight saving changes. */
export function sessionDateGroups(groups: readonly Group[], now = new Date()): Group[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const before = (days: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - days);
  const yesterday = before(1);
  const monday = before((today.getDay() + 6) % 7);
  const lastMonday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 7);
  const month = new Date(today.getFullYear(), today.getMonth(), 1);
  const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const bucket = (date: Date): string => {
    if (date >= today) return "Today";
    if (date >= yesterday) return "Yesterday";
    if (date >= monday) return date.toLocaleDateString("en-GB", { weekday: "long" });
    if (date >= lastMonday) return "Last week";
    if (date >= month) return "Earlier this month";
    if (date >= lastMonth) return "Last month";
    return date.getFullYear() === today.getFullYear()
      ? date.toLocaleDateString("en-GB", { month: "long" })
      : String(date.getFullYear());
  };
  const cards = groups.flatMap((group) => group.cards);
  const updated = (card: Group["cards"][number]) => Date.parse(card.sessions[0]?.updatedAt ?? card.updatedAt ?? "");
  cards.sort((a, b) => updated(b) - updated(a));
  const dated = new Map<string, Group["cards"][number][]>();
  for (const card of cards) {
    const time = updated(card);
    const title = Number.isFinite(time) ? bucket(new Date(time)) : "Older";
    const group = dated.get(title) ?? [];
    group.push(card);
    dated.set(title, group);
  }
  return [...dated].map(([title, cards]) => ({ id: `session-date:${title}`, title, cards, collapsed: false }));
}
