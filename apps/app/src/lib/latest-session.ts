import type { Session } from "@mondash/shared/contract";

/** Associated sessions arrive ranked by Jev; a quick-open gesture instead follows their latest activity. */
export function latestSession(sessions: readonly Session[]): Session | undefined {
  return sessions.reduce<Session | undefined>((latest, session) => {
    if (!latest) return session;
    const newer = Date.parse(session.updatedAt) - Date.parse(latest.updatedAt);
    return newer > 0 || (newer === 0 && (session.jev ?? 0) > (latest.jev ?? 0)) ? session : latest;
  }, undefined);
}
