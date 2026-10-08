import { Schema } from "effect";
import type { Group } from "./contract";

export const SearchCandidate = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  tool: Schema.Literals(["claude", "codex"]),
  title: Schema.String.check(Schema.isMaxLength(20000)),
  subtitle: Schema.String.check(Schema.isMaxLength(100)),
  preview: Schema.String.check(Schema.isMaxLength(1200)),
});
export const SessionSearchInput = Schema.Struct({
  query: Schema.String.check(
    Schema.isMaxLength(400),
    Schema.makeFilter((query) => query.trim().length >= 2),
  ),
  candidates: Schema.Array(SearchCandidate),
});
export type SessionSearchInput = typeof SessionSearchInput.Type;
export const SessionSearchResult = Schema.Struct({
  scores: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      tool: Schema.Literals(["claude", "codex"]),
      score: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
      confidence: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
    }),
  ),
});
export type SessionSearchResult = typeof SessionSearchResult.Type;

export function searchCandidates(groups: readonly Group[], showPreview: boolean) {
  return groups
    .flatMap((group) => group.cards)
    .flatMap((card) => {
      const session = card.sessions[0];
      return session
        ? [
            {
              id: session.id,
              tool: session.tool,
              title: card.title.slice(0, 20000),
              subtitle: card.subtitle,
              preview: showPreview ? (session.preview ?? "").slice(0, 1200) : "",
            },
          ]
        : [];
    })
    .sort((a, b) => `${a.tool}:${a.id}`.localeCompare(`${b.tool}:${b.id}`));
}

/** One ranked list across archive groups; fall back to text relevance while Jev is pending or unavailable. */
export function rankSessionGroups(
  groups: readonly Group[],
  query: string,
  scores: SessionSearchResult["scores"],
  showPreview: boolean,
): readonly Group[] {
  if (!query.trim()) return groups;
  const byId = new Map(scores.map((score) => [`${score.tool}:${score.id}`, score.score]));
  const words = query.trim().toLowerCase().split(/\s+/);
  const value = (card: Group["cards"][number]) => {
    const score = byId.get(`${card.sessions[0]?.tool}:${card.id}`);
    if (score !== undefined) return score;
    const content =
      `${card.title} ${card.subtitle} ${showPreview ? (card.sessions[0]?.preview ?? "") : ""}`.toLowerCase();
    return words.filter((word) => content.includes(word)).length / words.length;
  };
  const cards = groups
    .flatMap((group) => group.cards)
    .map((card) => ({
      ...card,
      sessions: card.sessions.map((session) => ({
        ...session,
        ...(byId.has(`${session.tool}:${session.id}`) ? { jev: byId.get(`${session.tool}:${session.id}`) } : {}),
      })),
    }))
    .sort((a, b) => value(b) - value(a) || Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""));
  return [{ id: "search", title: "Search results", collapsed: false, cards }];
}
