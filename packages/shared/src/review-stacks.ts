import type { Card, Group, PRStack } from "./contract.ts";

const repository = (url: string) => new URL(url).pathname.split("/").slice(1, 3).join("/");
const stackKey = (card: Card) =>
  card.stack && card.url ? `${repository(card.url).toLowerCase()}#${card.stack.number}` : undefined;

/** Presentation only: the feed's original groups remain the authority for each Review action. */
export function groupReviewStacks(groups: readonly Group[]): Group[] {
  const parents = groups.map((_, index) => index);
  const root = (index: number): number => (parents[index] === index ? index : (parents[index] = root(parents[index])));
  const join = (a: number, b: number) => {
    parents[root(b)] = root(a);
  };
  const stacks = new Map<string, number>();
  const urls = new Map<string, number>();
  groups.forEach((group, index) =>
    group.cards.forEach((card) => {
      if (card.url) urls.set(card.url, index);
    }),
  );
  groups.forEach((group, index) =>
    group.cards.forEach((card) => {
      const key = stackKey(card);
      if (!key) return;
      const previous = stacks.get(key);
      if (previous !== undefined) join(previous, index);
      else stacks.set(key, index);
      for (const entry of card.stack!.entries) {
        const member = urls.get(entry.url);
        if (member !== undefined) join(index, member);
      }
    }),
  );
  const members = new Map<number, Group[]>();
  groups.forEach((group, index) => {
    const key = root(index);
    const found = members.get(key) ?? [];
    found.push(group);
    members.set(key, found);
  });
  return [...members.values()].map((parts) => {
    const first = parts[0];
    if (!parts.some((part) => part.cards.some((card) => stackKey(card)))) return first;
    const cards = [...new Map(parts.flatMap((part) => part.cards).map((card) => [card.url ?? card.id, card])).values()];
    const layout = reviewStackLayout(cards);
    const reviewStacks = cards
      .filter((card) => card.stack && card.url)
      .map((card) => ({ url: card.url!, stack: card.stack! }))
      .sort(
        (a, b) =>
          Number(repository(b.url) === layout?.repository && b.stack.number === layout?.stack.number) -
          Number(repository(a.url) === layout?.repository && a.stack.number === layout?.stack.number),
      );
    const placed = cards.map((card) => {
      const layer = layout?.layers.find((layer) => layer.cards.includes(card));
      const entry = layout?.stack.entries.find((entry) => entry.position === layer?.position);
      return entry ? { ...card, reviewStackLayer: entry.url } : card;
    });
    return {
      ...first,
      title: layout ? `${layout.repository.split("/").at(-1)} · Stack #${layout.stack.number}` : first.title,
      reviewStacks,
      id: `review-stack:${parts
        .map((part) => part.id)
        .sort()
        .join("+")}`,
      presentation: "review-stack",
      cards: placed,
    };
  });
}

type Entry = PRStack["entries"][number];
export interface ReviewStackLayout {
  repository: string;
  stack: PRStack;
  layers: readonly { position?: number; cards: readonly Card[] }[];
  others: readonly Entry[];
}

/** Base upwards, with the original paired PRs beside their corresponding native layer. */
export function reviewStackLayout(
  cards: readonly Card[],
  context: Group["reviewStacks"] = [],
): ReviewStackLayout | undefined {
  const candidates = new Map<string, { repository: string; stack: PRStack; entries: Map<string, Entry> }>();
  for (const card of [...context.map((item) => ({ ...item, id: "context" })), ...cards]) {
    const key = card.stack && card.url ? `${repository(card.url).toLowerCase()}#${card.stack.number}` : undefined;
    if (!key || !card.stack || !card.url) continue;
    const candidate = candidates.get(key) ?? {
      repository: repository(card.url),
      stack: card.stack,
      entries: new Map(),
    };
    for (const entry of card.stack.entries) candidate.entries.set(entry.url, entry);
    candidates.set(key, candidate);
  }
  const score = (candidate: { entries: Map<string, Entry> }) =>
    cards.filter((card) => card.url && candidate.entries.has(card.url)).length;
  const primary = context.length
    ? candidates.get(`${repository(context[0].url).toLowerCase()}#${context[0].stack.number}`)
    : [...candidates.values()].sort((a, b) => score(b) - score(a) || a.repository.localeCompare(b.repository))[0];
  if (!primary) return;
  const entries = [...primary.entries.values()].sort((a, b) => a.position - b.position);
  const used = new Set<Card>();
  const layers: { position?: number; cards: Card[] }[] = [];
  const nativeURLs = new Set(entries.map((entry) => entry.url));
  for (const entry of entries) {
    const card =
      cards.find((card) => card.url === entry.url) ?? cards.find((card) => card.reviewStackLayer === entry.url);
    if (!card) continue;
    // Prefer explicit links. Shared tickets can join several layers into one action group.
    const paired = cards.filter((other) => {
      if (other === card || used.has(other) || nativeURLs.has(other.url ?? "")) return false;
      if (other.reviewStackLayer) return other.reviewStackLayer === entry.url;
      const matches = entries.filter((candidate) => {
        const member = cards.find((card) => card.url === candidate.url);
        if (!member) return false;
        if (member.reviewCompanions?.includes(other.url ?? "") || other.reviewCompanions?.includes(member.url ?? ""))
          return true;
        return (
          !!member.reviewGroupId &&
          member.reviewGroupId === other.reviewGroupId &&
          cards.filter((card) => card.reviewGroupId === member.reviewGroupId && nativeURLs.has(card.url ?? ""))
            .length === 1
        );
      });
      return matches.length === 1 && matches[0].url === entry.url;
    });
    const layer = [card, ...paired];
    layer.forEach((card) => used.add(card));
    layers.push({ position: entry.position, cards: layer });
  }
  for (const card of cards)
    if (!used.has(card)) {
      used.add(card);
      layers.push({ cards: [card] });
    }
  const actionable = new Set(cards.map((card) => card.url));
  const others = [
    ...new Map(
      [...candidates.values()]
        .flatMap((candidate) => [...candidate.entries.values()])
        .filter((entry) => !actionable.has(entry.url))
        .map((entry) => [entry.url, entry]),
    ).values(),
  ].sort((a, b) => repository(a.url).localeCompare(repository(b.url)) || a.position - b.position);
  return { repository: primary.repository, stack: { ...primary.stack, entries }, layers, others };
}
