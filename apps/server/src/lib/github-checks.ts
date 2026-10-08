import { Schema } from "effect";

export const ChecksSummary = Schema.Struct({
  passed: Schema.Finite,
  failed: Schema.Finite,
  pending: Schema.Finite,
  skipped: Schema.Finite,
  cancelled: Schema.optional(Schema.Finite),
});
export type ChecksSummary = typeof ChecksSummary.Type;

// Aggregate counts cover the whole connection. A bounded slice identifies AI checks.
// Unidentified checks remain in CI, including failures beyond that slice.
// https://docs.github.com/en/graphql/reference/commits#statuscheckrollupcontextconnection
export const CHECK_ROLLUP_FIELDS = `statusCheckRollup {
  state
  contexts(first: 100) {
    totalCount
    nodes {
      __typename
      ... on CheckRun { name status conclusion databaseId startedAt checkSuite { app { slug } workflowRun { workflow { id } } } }
      ... on StatusContext { context state createdAt }
    }
    checkRunCountsByState { state count }
    statusContextCountsByState { state count }
  }
}`;

const checkContext = Schema.Union([
  Schema.Struct({
    __typename: Schema.Literal("CheckRun"),
    name: Schema.String,
    status: Schema.String,
    conclusion: Schema.NullOr(Schema.String),
    databaseId: Schema.optional(Schema.NullOr(Schema.Finite)),
    startedAt: Schema.optional(Schema.NullOr(Schema.String)),
    checkSuite: Schema.Struct({
      app: Schema.NullOr(Schema.Struct({ slug: Schema.String })),
      workflowRun: Schema.optional(Schema.NullOr(Schema.Struct({ workflow: Schema.Struct({ id: Schema.String }) }))),
    }),
  }),
  Schema.Struct({
    __typename: Schema.Literal("StatusContext"),
    context: Schema.String,
    state: Schema.String,
    createdAt: Schema.optional(Schema.String),
  }),
]);

const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const stateCount = Schema.Struct({ state: Schema.String, count });
export const checkRollupSchema = Schema.NullOr(
  Schema.Struct({
    state: Schema.String,
    contexts: Schema.Struct({
      totalCount: count,
      nodes: Schema.optional(Schema.Array(Schema.NullOr(checkContext))),
      checkRunCountsByState: Schema.NullOr(Schema.Array(stateCount)),
      statusContextCountsByState: Schema.NullOr(Schema.Array(stateCount)),
    }),
  }),
);

/** Unknown/new states stay pending, so an incomplete rollup never appears all green. */
export function prChecks(rollup: typeof checkRollupSchema.Type): {
  checks: string | null;
  checksSummary?: ChecksSummary;
  aiCheckFailures: readonly string[];
} {
  if (!rollup || !rollup.contexts.totalCount) return { checks: null, aiCheckFailures: [] };
  const counts = [
    ...(rollup.contexts.checkRunCountsByState ?? []),
    ...(rollup.contexts.statusContextCountsByState ?? []),
  ];
  const summary = { passed: 0, failed: 0, pending: 0, skipped: 0, cancelled: 0 };
  for (const { state, count } of counts) summary[bucket(state)] += count;
  // Nullable aggregate lists should not hide checks which GitHub still counts in its total.
  summary.pending += Math.max(0, rollup.contexts.totalCount - Object.values(summary).reduce((a, b) => a + b, 0));
  const failures = new Set<string>();
  let removedPending = 0;
  const subtract = (node: typeof checkContext.Type) => {
    const aggregate =
      node.__typename === "CheckRun"
        ? rollup.contexts.checkRunCountsByState
        : rollup.contexts.statusContextCountsByState;
    const tone = aggregate === null ? "pending" : bucket(contextState(node));
    summary[tone] = Math.max(0, summary[tone] - 1);
    if (tone === "pending") removedPending += 1;
  };
  // GitHub's rollup contains historical workflow runs too. Retire only observed older results;
  // aggregate failures outside this page remain visible. Workflow identity keeps same-name jobs apart.
  const latest = new Map<string, (typeof checkContext.Type)[]>();
  for (const node of rollup.contexts.nodes ?? []) {
    if (!node) continue;
    const key =
      node.__typename === "CheckRun"
        ? JSON.stringify([
            node.__typename,
            node.checkSuite.app?.slug,
            node.checkSuite.workflowRun?.workflow.id,
            node.name,
          ])
        : JSON.stringify([node.__typename, node.context]);
    const previous = latest.get(key) ?? [];
    if (previous.some((peer) => compareContexts(peer, node) > 0)) subtract(node);
    else {
      const retained = previous.filter((peer) => {
        if (compareContexts(node, peer) <= 0) return true;
        subtract(peer);
        return false;
      });
      latest.set(key, [...retained, node]);
    }
  }
  for (const node of [...latest.values()].flat()) {
    if (!node) continue;
    const name = node.__typename === "CheckRun" ? node.name : node.context;
    const app = node.__typename === "CheckRun" ? node.checkSuite.app?.slug : undefined;
    // A known provider owns its checks; legacy contexts need an exact review name.
    // Ordinary GitHub Actions jobs, even if named after a bot, stay in CI.
    const isAI = app
      ? ["greptile", "greptile-apps", "coderabbit", "coderabbitai"].includes(app.toLowerCase())
      : /^(greptile review|coderabbit|coderabbitai|coderabbit review)$/i.test(name);
    if (!isAI) continue;
    const tone = bucket(contextState(node));
    subtract(node);
    if (tone === "failed") failures.add(name);
  }
  // Preserve GitHub's pending signal for checks that have not reported yet,
  // unless the pending checks we removed explain it.
  const checks =
    rollup.state === "PENDING" && !removedPending
      ? "PENDING"
      : summary.failed
        ? "FAILURE"
        : summary.pending
          ? "PENDING"
          : summary.cancelled
            ? "CANCELLED"
            : summary.passed || summary.skipped
              ? "SUCCESS"
              : null;
  // Keep older caches/clients compatible when there are no cancellations.
  const { cancelled, ...completed } = summary;
  return { checks, checksSummary: cancelled ? summary : completed, aiCheckFailures: [...failures] };
}

function bucket(state: string): keyof ChecksSummary {
  if (state === "SUCCESS") return "passed";
  if (["NEUTRAL", "SKIPPED"].includes(state)) return "skipped";
  if (state === "CANCELLED") return "cancelled";
  if (["FAILURE", "ERROR", "ACTION_REQUIRED", "TIMED_OUT", "STALE", "STARTUP_FAILURE"].includes(state)) return "failed";
  return "pending";
}

function contextState(node: typeof checkContext.Type): string {
  return node.__typename === "CheckRun"
    ? node.status === "COMPLETED"
      ? (node.conclusion ?? node.status)
      : node.status
    : node.state;
}
/** Compare the same kind of metadata; retain both results when their order is unknown. */
function compareContexts(a: typeof checkContext.Type, b: typeof checkContext.Type): number {
  if (a.__typename !== b.__typename) return 0;
  if (a.__typename === "CheckRun" && b.__typename === "CheckRun" && a.databaseId != null && b.databaseId != null)
    return a.databaseId - b.databaseId;
  const aTime = Date.parse((a.__typename === "CheckRun" ? a.startedAt : a.createdAt) ?? "");
  const bTime = Date.parse((b.__typename === "CheckRun" ? b.startedAt : b.createdAt) ?? "");
  return Number.isFinite(aTime) && Number.isFinite(bTime) ? aTime - bTime : 0;
}
