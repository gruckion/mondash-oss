import type { Group, Session } from "@mondash/shared/contract";

export type ReviewSessionLink = {
  sessionId?: string;
  urls: string[];
  title: string;
  createdAt: string;
  state: "starting" | "ready" | "failed";
};

/** Explicit launches are available immediately, before transcript discovery catches up. */
export function attachReviewSessions(groups: readonly Group[], launches: readonly ReviewSessionLink[]): Group[] {
  return groups.map((group) => ({
    ...group,
    cards: group.cards.map((card) => {
      const url = card.url;
      if (card.kind !== "review" || !url) return card;
      const launched = launches.filter(
        (launch) =>
          launch.state === "ready" &&
          launch.sessionId &&
          launch.urls.includes(url) &&
          !card.sessions.some((session) => session.id === launch.sessionId),
      );
      const started: Session[] = launched.flatMap((launch) =>
        launch.sessionId
          ? [
              {
                id: launch.sessionId,
                tool: "claude",
                title: launch.title,
                updatedAt: launch.createdAt,
                canOpenOnMac: true,
                canOpenInClaude: true,
              },
            ]
          : [],
      );
      const sessions = [...card.sessions, ...started].sort(
        (a, b) => (b.jev ?? 1) - (a.jev ?? 1) || b.updatedAt.localeCompare(a.updatedAt),
      );
      return { ...card, sessions };
    }),
  }));
}
