import { Schema } from "effect";
import type { PRStack } from "@mondash/shared/contract";

export const STACK_FIELDS = `stackEntry { position } stack {
  number size baseRefName entries(first: 100) { nodes { position pullRequest {
    number title url state isDraft mergeable mergeStateStatus reviewDecision
  } } }
}`;

const Entry = Schema.Struct({
  position: Schema.Finite,
  pullRequest: Schema.NullOr(
    Schema.Struct({
      number: Schema.Finite,
      title: Schema.String,
      url: Schema.String,
      state: Schema.String,
      isDraft: Schema.Boolean,
      mergeable: Schema.String,
      mergeStateStatus: Schema.String,
      reviewDecision: Schema.NullOr(Schema.String),
    }),
  ),
});
export const stackFields = {
  stackEntry: Schema.optional(Schema.NullOr(Schema.Struct({ position: Schema.Finite }))),
  stack: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        number: Schema.Finite,
        size: Schema.Finite,
        baseRefName: Schema.String,
        entries: Schema.Struct({ nodes: Schema.Array(Schema.NullOr(Entry)) }),
      }),
    ),
  ),
};

/** No branch-name guessing: stack membership and order come from GitHub. */
export function prStack(pr: {
  readonly stack?: typeof stackFields.stack.Type;
  readonly stackEntry?: typeof stackFields.stackEntry.Type;
}): PRStack | undefined {
  if (!pr.stack || !pr.stackEntry) return undefined;
  return {
    number: pr.stack.number,
    position: pr.stackEntry.position,
    size: pr.stack.size,
    base: pr.stack.baseRefName,
    entries: pr.stack.entries.nodes
      .flatMap((entry) =>
        entry?.pullRequest
          ? [
              {
                position: entry.position,
                number: entry.pullRequest.number,
                title: entry.pullRequest.title,
                url: entry.pullRequest.url,
                status: mergeStatus(entry.pullRequest),
              },
            ]
          : [],
      )
      .sort((a, b) => a.position - b.position),
  };
}

function mergeStatus(pr: NonNullable<typeof Entry.Type.pullRequest>): PRStack["entries"][number]["status"] {
  if (pr.state === "MERGED") return "Merged";
  if (pr.state === "CLOSED") return "Closed";
  if (pr.isDraft) return "Draft";
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") return "Conflicts";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "Changes requested";
  if (pr.reviewDecision === "REVIEW_REQUIRED") return "Approval needed";
  if (pr.mergeStateStatus === "BEHIND") return "Behind base";
  if (pr.mergeStateStatus === "UNSTABLE") return "Checks not passed";
  if (pr.mergeStateStatus === "BLOCKED") return "Blocked";
  if (pr.mergeable === "UNKNOWN" || pr.mergeStateStatus !== "CLEAN") return "Checking";
  return "Ready";
}
