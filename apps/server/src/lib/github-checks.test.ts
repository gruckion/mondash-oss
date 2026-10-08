import assert from "node:assert/strict";
import { test } from "node:test";
import { prChecks } from "./github-checks.ts";

const checksSummary = (rollup: Parameters<typeof prChecks>[0]) => prChecks(rollup).checksSummary;

test("cancelled lint remains cancelled when the other four checks passed", () => {
  const result = prChecks({
    state: "FAILURE",
    contexts: {
      totalCount: 5,
      checkRunCountsByState: [
        { state: "SUCCESS", count: 4 },
        { state: "CANCELLED", count: 1 },
      ],
      statusContextCountsByState: [],
    },
  });
  assert.equal(result.checks, "CANCELLED");
  assert.deepEqual(result.checksSummary, { passed: 4, failed: 0, pending: 0, skipped: 0, cancelled: 1 });
});

test("counts check runs and legacy statuses across the entire rollup", () => {
  assert.deepEqual(
    checksSummary({
      state: "PENDING",
      contexts: {
        totalCount: 209,
        checkRunCountsByState: [
          { state: "SUCCESS", count: 200 },
          { state: "IN_PROGRESS", count: 3 },
          { state: "SKIPPED", count: 1 },
          { state: "NEUTRAL", count: 1 },
        ],
        statusContextCountsByState: [
          { state: "SUCCESS", count: 2 },
          { state: "PENDING", count: 1 },
          { state: "ERROR", count: 1 },
        ],
      },
    }),
    { passed: 202, pending: 4, skipped: 2, failed: 1 },
  );
});

test("does not present missing, unknown or non-successful checks as passing", () => {
  const failures = ["FAILURE", "ACTION_REQUIRED", "TIMED_OUT", "STALE", "STARTUP_FAILURE"];
  assert.deepEqual(
    checksSummary({
      state: "FAILURE",
      contexts: {
        totalCount: 11,
        checkRunCountsByState: [
          ...failures.map((state) => ({ state, count: 1 })),
          { state: "CANCELLED", count: 1 },
          { state: "COMPLETED", count: 1 },
          { state: "FUTURE_STATE", count: 1 },
        ],
        statusContextCountsByState: null,
      },
    }),
    { passed: 0, pending: 5, skipped: 0, failed: 5, cancelled: 1 },
  );
});

test("absent checks remain absent instead of implying success", () => {
  assert.equal(checksSummary(null), undefined);
  assert.equal(
    checksSummary({
      state: "SUCCESS",
      contexts: { totalCount: 0, checkRunCountsByState: [], statusContextCountsByState: [] },
    }),
    undefined,
  );
});

const aiFailure = {
  state: "FAILURE",
  contexts: {
    totalCount: 8,
    checkRunCountsByState: [
      { state: "SUCCESS", count: 7 },
      { state: "FAILURE", count: 1 },
    ],
    statusContextCountsByState: [],
    nodes: [
      {
        __typename: "CheckRun" as const,
        name: "Greptile Review",
        status: "COMPLETED",
        conclusion: "FAILURE",
        checkSuite: { app: { slug: "greptile" } },
      },
    ],
  },
};

test("a failing AI review does not count as a failing CI check", () => {
  assert.deepEqual(prChecks(aiFailure), {
    checks: "SUCCESS",
    checksSummary: { passed: 7, failed: 0, pending: 0, skipped: 0 },
    aiCheckFailures: ["Greptile Review"],
  });
});

test("separates AI and CI failures without dropping checks beyond the fetched page", () => {
  assert.deepEqual(
    prChecks({
      ...aiFailure,
      contexts: {
        ...aiFailure.contexts,
        totalCount: 209,
        checkRunCountsByState: [
          { state: "SUCCESS", count: 200 },
          { state: "FAILURE", count: 9 },
        ],
      },
    }),
    {
      checks: "FAILURE",
      checksSummary: { passed: 200, failed: 8, pending: 0, skipped: 0 },
      aiCheckFailures: ["Greptile Review"],
    },
  );
});

test("AI-only failure and legacy review checks do not manufacture CI results", () => {
  for (const state of ["FAILURE", "PENDING", "SUCCESS"]) {
    const result = prChecks({
      state,
      contexts: {
        totalCount: 1,
        checkRunCountsByState: [],
        statusContextCountsByState: [{ state, count: 1 }],
        nodes: [{ __typename: "StatusContext", context: "CodeRabbit", state }],
      },
    });
    assert.deepEqual(result, {
      checks: null,
      checksSummary: { passed: 0, failed: 0, pending: 0, skipped: 0 },
      aiCheckFailures: state === "FAILURE" ? ["CodeRabbit"] : [],
    });
  }
});

test("unknown providers and similarly named CI jobs keep their failures", () => {
  for (const node of [
    { ...aiFailure.contexts.nodes[0], checkSuite: { app: { slug: "github-actions" } } },
    { ...aiFailure.contexts.nodes[0], name: "Security review", checkSuite: { app: { slug: "security-bot" } } },
    { __typename: "StatusContext" as const, context: "CodeRabbit integration tests", state: "FAILURE" },
    null,
  ]) {
    const result = prChecks({ ...aiFailure, contexts: { ...aiFailure.contexts, nodes: [node] } });
    assert.equal(result.checks, "FAILURE");
    assert.deepEqual(result.aiCheckFailures, []);
    assert.equal(result.checksSummary?.failed, 1);
  }
});

test("running AI reviews and cancelled reviews are separate from CI and never hide pending CI", () => {
  assert.deepEqual(
    prChecks({
      ...aiFailure,
      state: "PENDING",
      contexts: {
        ...aiFailure.contexts,
        checkRunCountsByState: [
          { state: "SUCCESS", count: 7 },
          { state: "IN_PROGRESS", count: 1 },
        ],
        nodes: [{ ...aiFailure.contexts.nodes[0], status: "IN_PROGRESS", conclusion: null }],
      },
    }),
    {
      checks: "SUCCESS",
      checksSummary: { passed: 7, failed: 0, pending: 0, skipped: 0 },
      aiCheckFailures: [],
    },
  );
  const result = prChecks({
    ...aiFailure,
    state: "PENDING",
    contexts: {
      ...aiFailure.contexts,
      totalCount: 9,
      checkRunCountsByState: [
        { state: "SUCCESS", count: 7 },
        { state: "IN_PROGRESS", count: 1 },
        { state: "CANCELLED", count: 1 },
      ],
      nodes: [{ ...aiFailure.contexts.nodes[0], conclusion: "CANCELLED" }],
    },
  });
  assert.equal(result.checks, "PENDING");
  assert.deepEqual(result.checksSummary, { passed: 7, failed: 0, pending: 1, skipped: 0 });
  assert.deepEqual(result.aiCheckFailures, []);
});

test("missing aggregate lists do not leave phantom CI or subtract a real CI failure", () => {
  for (const legacy of [null, [{ state: "FAILURE", count: 1 }]]) {
    assert.deepEqual(
      prChecks({
        ...aiFailure,
        contexts: {
          ...aiFailure.contexts,
          totalCount: legacy ? 2 : 1,
          checkRunCountsByState: null,
          statusContextCountsByState: legacy,
        },
      }),
      {
        checks: legacy ? "FAILURE" : null,
        checksSummary: { passed: 0, failed: legacy ? 1 : 0, pending: 0, skipped: 0 },
        aiCheckFailures: ["Greptile Review"],
      },
    );
  }
});

test("latest runs replace superseded results without merging different workflows or hiding unfetched failures", () => {
  const run = (id: number, conclusion: string | null, workflow = "compatibility") => ({
    __typename: "CheckRun" as const,
    name: "API compatibility",
    databaseId: id,
    status: conclusion ? "COMPLETED" : "QUEUED",
    conclusion,
    checkSuite: { app: { slug: "github-actions" }, workflowRun: { workflow: { id: workflow } } },
  });
  for (const { nodes, total, counts, expected } of [
    {
      nodes: [
        { ...run(1, "FAILURE"), databaseId: null, startedAt: "2026-10-05T10:00:00Z" },
        { ...run(2, "SUCCESS"), startedAt: "2026-10-05T11:00:00Z" },
      ],
      total: 2,
      counts: [
        { state: "SUCCESS", count: 1 },
        { state: "FAILURE", count: 1 },
      ],
      expected: { passed: 1, failed: 0, pending: 0, skipped: 0 },
    },
    {
      nodes: [{ ...run(1, "FAILURE"), databaseId: null }, run(2, "SUCCESS")],
      total: 2,
      counts: [
        { state: "SUCCESS", count: 1 },
        { state: "FAILURE", count: 1 },
      ],
      expected: { passed: 1, failed: 1, pending: 0, skipped: 0 },
    },
    {
      nodes: [run(2, "SUCCESS"), run(1, "FAILURE")],
      total: 2,
      counts: [
        { state: "SUCCESS", count: 1 },
        { state: "FAILURE", count: 1 },
      ],
      expected: { passed: 1, failed: 0, pending: 0, skipped: 0 },
    },
    {
      nodes: [run(1, "SUCCESS"), run(2, null)],
      total: 2,
      counts: [
        { state: "SUCCESS", count: 1 },
        { state: "QUEUED", count: 1 },
      ],
      expected: { passed: 0, failed: 0, pending: 1, skipped: 0 },
    },
    {
      nodes: [run(1, "FAILURE"), run(2, "SUCCESS", "other-workflow")],
      total: 2,
      counts: [
        { state: "SUCCESS", count: 1 },
        { state: "FAILURE", count: 1 },
      ],
      expected: { passed: 1, failed: 1, pending: 0, skipped: 0 },
    },
    {
      nodes: [run(1, "FAILURE"), run(2, "SUCCESS")],
      total: 3,
      counts: [
        { state: "SUCCESS", count: 1 },
        { state: "FAILURE", count: 2 },
      ],
      expected: { passed: 1, failed: 1, pending: 0, skipped: 0 },
    },
  ]) {
    assert.deepEqual(
      checksSummary({
        state: "FAILURE",
        contexts: { totalCount: total, nodes, checkRunCountsByState: counts, statusContextCountsByState: [] },
      }),
      expected,
    );
  }
});
