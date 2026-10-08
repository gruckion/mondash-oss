import type { Row } from "./contract";
import type { PRState } from "./pr-icons";

/** Preserve the merged marker on older snapshots, then use explicit state or status. */
export function rowPRState(row: Row): PRState {
  if (row.merged) return "MERGED";
  return (
    row.prState ??
    (row.status?.toUpperCase() === "MERGED"
      ? "MERGED"
      : row.status?.toUpperCase() === "CLOSED"
        ? "CLOSED"
        : row.draft
          ? "DRAFT"
          : "OPEN")
  );
}

/** Finished PRs fold into Other PRs; open and draft PRs stay inline. */
export function isOtherPR(row: Row): boolean {
  if (row.kind !== "pr") return false;
  const state = rowPRState(row);
  return state === "MERGED" || state === "CLOSED";
}
