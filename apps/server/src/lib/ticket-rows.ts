import { Effect } from "effect";
import type { Group, Row } from "@mondash/shared/contract";

/**
 * PR feeds only carry ticket IDs. Fill their rows with one lookup for all of them, without making a provider failure
 * hide the feed.
 */
export const enrichTicketRows = <E, R>(
  groups: ReadonlyArray<Group>,
  lookup: (ids: ReadonlyArray<string>) => Effect.Effect<ReadonlyMap<string, Row>, E, R>,
): Effect.Effect<Group[], never, R> => {
  const missing = groups
    .flatMap((group) => group.cards.flatMap((card) => card.rows ?? []))
    .filter((row) => row.kind === "ticket" && row.reference && row.title === row.reference);
  const byId = Map.groupBy(missing, (row) => row.reference!);
  if (byId.size === 0) return Effect.succeed([...groups]);
  return lookup([...byId.keys()]).pipe(
    Effect.map((tickets) => {
      const patches = new Map<Row, Row>();
      for (const [id, rows] of byId) {
        const ticket = tickets.get(id);
        if (ticket?.kind !== "ticket" || ticket.reference !== id) continue;
        for (const row of rows) patches.set(row, { ...row, ...ticket });
      }
      return groups.map((group) => ({
        ...group,
        cards: group.cards.map((card) => ({
          ...card,
          ...(card.rows ? { rows: card.rows.map((row) => patches.get(row) ?? row) } : {}),
        })),
      }));
    }),
    // The ticket link remains usable when Linear is unavailable or the ticket was deleted.
    Effect.orElseSucceed(() => [...groups]),
  );
};
