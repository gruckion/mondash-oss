// Deciding which Linear ticket comments are waiting on you. No "@/" imports, so tests can import it.
import { toReply, type Reply } from "./people.ts";

export type TicketComment = {
  id: string;
  author: string;
  createdAt: Date;
  /** The comment this replies to, or undefined for the start of a thread. */
  parentId?: string;
  resolved: boolean;
};

/**
 * Open threads where someone else had the last word and it is yours to answer:
 * you wrote in that thread, or the ticket is yours. Replying or resolving clears it.
 */
export function ticketReply(comments: TicketComment[], me: string, yours: boolean, issueUrl: string): Reply | null {
  const threads = Map.groupBy(comments, (c) => (c.parentId === undefined ? c.id : c.parentId));
  const waiting = [...threads.values()].flatMap((thread) => {
    const ordered = thread.toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const last = ordered.at(-1);
    if (!last || last.author === me || ordered.some((c) => c.resolved)) return [];
    return yours || ordered.some((c) => c.author === me)
      ? [{ from: last.author, at: last.createdAt, url: `${issueUrl}#comment-${last.id}` }]
      : [];
  });
  return toReply(waiting);
}
