import { Option, Schema } from "effect";
import { candidates, countRefs, refKeys } from "./refs.ts";
import type { AgentSession } from "./sessions.ts";

const decodePRLink = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("pr-link"),
    sessionId: Schema.String,
    prUrl: Schema.String,
  }),
);

/** Claude records these associations itself, independently of conversation titles. */
export function linkedPRRefs(records: unknown[], sessionId: string): string[] {
  const refs = new Set<string>();
  for (const record of records) {
    const parsed = decodePRLink(record);
    if (Option.isNone(parsed) || parsed.value.sessionId !== sessionId) continue;
    const match = parsed.value.prUrl.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#]|$)/i);
    if (match) refs.add(`pr:${match[1]}#${match[2]}`);
  }
  return [...refs];
}

type Item = { key: string; refs: string[]; ownPRs?: string[] };
export const SESSION_MATCH_THRESHOLD = 0.7;
type SessionRefs = Pick<AgentSession, "refs" | "linkedPRs"> &
  Partial<Pick<AgentSession, "promptRefs" | "title" | "firstPrompt" | "branch">>;

export function sessionCandidates<T extends Item>(items: T[], session: SessionRefs): T[] {
  return candidates(items, {
    ...session.refs,
    ...countRefs([session.branch, session.title, session.firstPrompt].join("\n")),
    ...Object.fromEntries((session.linkedPRs ?? []).map((ref) => [ref, 1])),
  });
}

/** Claude recorded the PR, or you pasted its link into a prompt yourself: either way the session worked on it. */
export function explicitlyLinked(item: Item, session: SessionRefs): boolean {
  const pasted = (item.ownPRs ?? item.refs).filter((ref) => ref.startsWith("pr:"));
  return (
    item.refs.some((ref) => session.linkedPRs?.includes(ref)) ||
    pasted.some((ref) => (session.promptRefs?.[ref] ?? 0) > 0)
  );
}

/**
 * Worth asking Jev: you named the item in your own prompts, or the session keeps coming back to it (a Codex session
 * that reads a pasted doc all through, for example). One or two mentions in tool output are not.
 */
export const worthAsking = (item: Item, session: SessionRefs) => {
  const named = new Set(refKeys([session.branch, session.title, session.firstPrompt].join("\n")));
  return (
    explicitlyLinked(item, session) ||
    item.refs.some((ref) => named.has(ref) || (session.promptRefs?.[ref] ?? 0) > 0 || (session.refs[ref] ?? 0) >= 5)
  );
};

/** Only Jev-approved automatic associations belong in an item's session list. */
export function selectSessionItems<T extends Item>(items: T[], scores: Record<string, number | undefined>): T[] {
  return items.filter((item) => (scores[item.key] ?? 0) >= SESSION_MATCH_THRESHOLD);
}
