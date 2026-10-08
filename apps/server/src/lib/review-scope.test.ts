import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createReviewScopeResolver,
  ReviewScopeError,
  parseReviewPRUrl,
  readyForReview,
  relatedPRUrls,
  type ReviewScopeDependencies,
  type ReviewScopePR,
} from "./review-scope.ts";

const url = (repo: string, n: number) => `https://github.com/ExampleOrg/${repo}/pull/${n}`;
const a = url("core", 10),
  b = url("web", 20),
  c = url("admin-console", 30),
  d = url("mobile-app", 40);
function harness(prs: Partial<ReviewScopePR & { url: string }>[], groups = [[{ url: a }]]) {
  const loaded: string[] = [];
  const ticketCalls: string[] = [];
  const records = new Map(
    prs.map((pr) => [
      pr.url!,
      {
        title: "Change",
        body: "",
        branch: "feature",
        state: "OPEN" as const,
        comments: [],
        ready: true,
        ...pr,
      } as ReviewScopePR,
    ]),
  );
  const deps: ReviewScopeDependencies = {
    groups: async () => groups,
    cwd: async () => "/server/workspace",
    load: async (value) => {
      loaded.push(value);
      const pr = records.get(value);
      if (!pr) throw new Error(`Unknown PR ${value}`);
      return pr;
    },
    forTicket: async (ticket) => {
      ticketCalls.push(ticket);
      return [];
    },
  };
  return { deps, loaded, ticketCalls };
}

test("review URL validation rejects off-host, credentials, invalid number and arbitrary paths", () => {
  for (const value of [
    "https://evil/github.com/ExampleOrg/core/pull/10",
    "http://github.com/ExampleOrg/core/pull/10",
    "https://user@github.com/ExampleOrg/core/pull/10",
    "https://github.com:444/ExampleOrg/core/pull/10",
    "https://github.com/ExampleOrg/core/pull/0",
    "https://github.com/ExampleOrg/core/pull/10/files",
    "file:///tmp/a",
    "https://github.com/ExampleOrg/core/pull/99999999999999999999",
  ])
    assert.equal(parseReviewPRUrl(value), undefined);
  assert.equal(parseReviewPRUrl(`${a}#discussion-1`)?.url, a);
});

test("explicit related links support full URLs and short references while retaining organization boundary", () => {
  assert.deepEqual(
    relatedPRUrls(
      `Together with ${b} and admin-console#30. OtherOrg/web#99 and https://github.com/OtherOrg/core/pull/99 are unrelated.`,
      "ExampleOrg",
    ),
    [b, c],
  );
});

test("selection must still be present in the server review feed before loading or launching", async () => {
  const h = harness([{ url: a }]);
  await assert.rejects(
    createReviewScopeResolver(h.deps)(b),
    (error) => error instanceof ReviewScopeError && /no longer in Reviews/.test(error.message),
  );
  assert.deepEqual(h.loaded, []);
});

test("same review combines existing group, description, follow-up comments and shared Linear attachments", async () => {
  const h = harness(
    [
      { url: a, title: "Fix DEMO-123", body: `Companion ${b}`, comments: ["Initial discussion", `Follow up: ${c}`] },
      { url: b, body: `See ${a}`, comments: [] },
      { url: c, title: "Client fix DEMO-123" },
      { url: d },
    ],
    [[{ url: a }, { url: b }]],
  );
  h.deps.forTicket = async (ticket) => {
    h.ticketCalls.push(ticket);
    return [d];
  };
  const scope = await createReviewScopeResolver(h.deps)(a);
  assert.deepEqual(scope, { urls: [a, b, c, d], cwd: "/server/workspace", title: "Fix DEMO-123", notReady: [] });
  assert.equal(h.loaded.length, 4);
  assert.deepEqual(h.ticketCalls, ["DEMO-123"]);
});

test("historical merged links and cross-org links do not expand a current review", async () => {
  const h = harness([
    { url: a, body: `Compare ${b} and https://github.com/OtherOrg/web/pull/99` },
    { url: b, state: "MERGED", body: c },
  ]);
  const scope = await createReviewScopeResolver(h.deps)(a);
  assert.deepEqual(scope.urls, [a]);
  assert.deepEqual(h.loaded, [a, b]);
});

test("closed selected PR and GitHub identity mismatch fail instead of launching", async () => {
  const h = harness([{ url: a, state: "CLOSED" }]);
  await assert.rejects(createReviewScopeResolver(h.deps)(a), /already closed/);
  h.deps.load = async () => ({
    url: b,
    title: "Wrong",
    body: "",
    branch: "",
    state: "OPEN",
    comments: [],
    ready: true,
  });
  await assert.rejects(createReviewScopeResolver(h.deps)(a), /unexpected pull request/);
});

test("incidental ticket mentions in comments are not ownership links", async () => {
  const h = harness([{ url: a, comments: ["Not the same as DEMO-999"] }]);
  await createReviewScopeResolver(h.deps)(a);
  assert.deepEqual(h.ticketCalls, []);
});

test("missing related-PR data fails instead of quietly launching an incomplete review", async () => {
  const h = harness([{ url: a, body: b }]);
  await assert.rejects(createReviewScopeResolver(h.deps)(a), /Unknown PR/);
});

test("a large connected component fails explicitly instead of silently truncating", async () => {
  const prs = Array.from({ length: 21 }, (_, index) => ({
    url: url("core", index + 10),
    body: index < 20 ? url("core", index + 11) : "",
  }));
  const h = harness(prs);
  await assert.rejects(createReviewScopeResolver(h.deps)(a), /More than 20/);
});

test("a related PR that is not ready for human review is named, not reviewed, and its links are not followed", async () => {
  const h = harness([{ url: a, body: `Pairs with ${b}` }, { url: b, body: `See ${c}`, ready: false }, { url: c }]);
  const scope = await createReviewScopeResolver(h.deps)(a);
  assert.deepEqual(scope.urls, [a]);
  assert.deepEqual(scope.notReady, [b]);
  assert.equal(h.loaded.includes(c), false);
});

test("the tapped PR joins even when it is not ready", async () => {
  const h = harness([{ url: a, ready: false }]);
  const scope = await createReviewScopeResolver(h.deps)(a);
  assert.deepEqual(scope.urls, [a]);
  assert.deepEqual(scope.notReady, []);
});

test("ready for review: the devs team or any human requested; AI reviewers and drafts do not count", () => {
  const human = { login: "renee-demo", type: "User" };
  const bot = { login: "coderabbitai", type: "User" };
  const app = { login: "copilot-pull-request-reviewer[bot]", type: "Bot" };
  const devs = { slug: "devs" };
  const base = { draft: false, requestedReviewers: [], requestedTeams: [] };
  assert.equal(readyForReview(base, false), false);
  assert.equal(readyForReview({ ...base, requestedTeams: [devs] }, false), true);
  assert.equal(readyForReview({ ...base, requestedReviewers: [human] }, false), true);
  assert.equal(readyForReview({ ...base, requestedReviewers: [bot, app] }, false), false);
  assert.equal(readyForReview({ ...base, draft: true, requestedTeams: [devs] }, false), false);
  assert.equal(readyForReview(base, true), true);
});
