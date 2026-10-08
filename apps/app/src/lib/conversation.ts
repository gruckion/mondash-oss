import type { ConversationEdit, ConversationTurn } from "@mondash/shared/contract";

export type ConversationItem =
  { kind: "message"; turn: ConversationTurn } | { kind: "work"; id: string; turns: readonly ConversationTurn[] };

/** Completed work collapses above its provider-marked final reply; unfinished work remains visible. */
export function conversationItems(turns: readonly ConversationTurn[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  let work: ConversationTurn[] = [];
  const flush = () => {
    items.push(...work.map((turn): ConversationItem => ({ kind: "message", turn })));
    work = [];
  };
  for (const turn of turns) {
    if (turn.role === "user" || turn.context) {
      flush();
      items.push({ kind: "message", turn });
    } else if (turn.phase === "final") {
      const files = new Map<string, ConversationEdit>();
      for (const edit of [...work.flatMap((message) => message.edits ?? []), ...(turn.edits ?? [])]) {
        const previous = files.get(edit.file.id);
        files.set(
          edit.file.id,
          previous
            ? {
                ...edit,
                diff: `${previous.diff}\n${edit.diff}`,
                additions: previous.additions + edit.additions,
                deletions: previous.deletions + edit.deletions,
              }
            : edit,
        );
      }
      const edits = [...files.values()];
      if (work.length) {
        items.push({ kind: "work", id: `work:${turn.id ?? turn.at ?? turn.text}`, turns: work });
        work = [];
      }
      items.push({ kind: "message", turn: edits.length ? { ...turn, edits } : turn });
    } else work.push(turn);
  }
  flush();
  return items;
}
