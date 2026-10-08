import { createContext, use, useState, type ReactNode } from "react";
import type { PromptRequest } from "@mondash/shared/api";
import type { Card, ConflictFix, Row } from "@mondash/shared/contract";

export type SessionGroup = Pick<Card, "id" | "title" | "sessions"> & {
  label: string;
  /** An issue's Linear ticket, so the sheet can start another Claude session for it. */
  ticket?: { id: string; url: string; prs: readonly string[] };
  /** Shared stacks offer an explicit ticket choice instead of silently starting on the first ticket. */
  tickets?: readonly { id: string; url: string; prs: readonly string[] }[];
  /** A PR's link, when it has no known ticket, so the sheet can start another Claude session for it. */
  pr?: string;
  /** A review card's PR, so the sheet can start a new review of it. */
  review?: string;
};
/** Rows a card keeps out of the way (merged PRs, Slack threads), shown in a sheet. */
type RowsGroup = {
  heading: string;
  title: string;
  rows: readonly Row[];
  onLinked: () => void;
};
/** A conflicting PR, and the prompt that hands its fix to Codex. */
type ConflictSheet = { pr: string; fix: ConflictFix };
/** A Claude start that sends a prompt, shown first so the person can read and edit it. */
export type PromptSheet = {
  /** What the start does, such as "Plan DEMO-4214 in Claude". */
  title: string;
  detail: string;
  request: typeof PromptRequest.Type;
  onStarted: () => void;
};
const SessionSheet = createContext<{
  group: SessionGroup | null;
  rows: RowsGroup | null;
  conflict: ConflictSheet | null;
  prompt: PromptSheet | null;
} | null>(null);
type Setters = {
  setGroup: (group: SessionGroup) => void;
  setRows: (rows: RowsGroup) => void;
  setConflict: (conflict: ConflictSheet) => void;
  setPrompt: (prompt: PromptSheet) => void;
};
// The cards only open sheets. On their own context, opening one does not re-render every card on every tab.
const SessionSheetSetters = createContext<Setters | null>(null);

export function SessionSheetProvider({ children }: { children: ReactNode }) {
  const [group, setGroup] = useState<SessionGroup | null>(null);
  const [rows, setRows] = useState<RowsGroup | null>(null);
  const [conflict, setConflict] = useState<ConflictSheet | null>(null);
  const [prompt, setPrompt] = useState<PromptSheet | null>(null);
  const [setters] = useState<Setters>(() => ({ setGroup, setRows, setConflict, setPrompt }));
  return (
    <SessionSheetSetters value={setters}>
      <SessionSheet value={{ group, rows, conflict, prompt }}>{children}</SessionSheet>
    </SessionSheetSetters>
  );
}

/** What the open sheet shows. */
export function useSessionSheet() {
  const state = use(SessionSheet);
  if (!state) throw new Error("Session sheet provider missing");
  return state;
}

/** Sets what a sheet shows, before opening it. */
export function useOpenSheet() {
  const setters = use(SessionSheetSetters);
  if (!setters) throw new Error("Session sheet provider missing");
  return setters;
}
