import { Schema } from "effect";
import { PRChanges } from "@mondash/shared/contract";

// Optional for older snapshots/fixtures; missing counts must not become made-up zeroes.
export const changeFields = {
  additions: Schema.optional(PRChanges.fields.additions),
  deletions: Schema.optional(PRChanges.fields.deletions),
  changedFiles: Schema.optional(PRChanges.fields.files),
};

export function prChanges(pr: {
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}): PRChanges | undefined {
  return pr.additions === undefined || pr.deletions === undefined || pr.changedFiles === undefined
    ? undefined
    : { additions: pr.additions, deletions: pr.deletions, files: pr.changedFiles };
}
