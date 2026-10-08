// Run: node --test src/lib/github.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Logger, Schema } from "effect";
import { TestClock } from "effect/testing";
import { Store } from "@/services/store";
import { Gh } from "@/services/gh";
import { attention, getMyOpenPRs, getMyOtherPRs, getReviewFeed, probeGitHub } from "./github.ts";

const by = (login: string, createdAt: string, __typename = "User") => ({
  author: { login, __typename },
  createdAt,
  url: `u/${login}/${createdAt}`,
});
const thread = (isResolved: boolean, ...comments: ReturnType<typeof by>[]) => ({
  isResolved,
  comments: { nodes: comments },
});

for (const counts of [
  { additions: 178, deletions: 19, changedFiles: 8 },
  { additions: 0, deletions: 0, changedFiles: 1 },
  undefined,
]) {
  test(`PR change counts survive open, finished and review fetchers: ${counts ? JSON.stringify(counts) : "older snapshot"}`, async () => {
    const now = new Date().toISOString();
    const stack = {
      number: 2500,
      size: 2,
      baseRefName: "main",
      entries: {
        nodes: [
          {
            position: 1,
            pullRequest: {
              number: 2498,
              title: "Base PR",
              url: "https://github.com/example/app/pull/2498",
              state: "OPEN",
              isDraft: false,
              mergeable: "CONFLICTING",
              mergeStateStatus: "DIRTY",
              reviewDecision: "APPROVED",
            },
          },
          {
            position: 2,
            pullRequest: {
              number: 2499,
              title: "Top PR",
              url: "https://github.com/example/app/pull/2499",
              state: "OPEN",
              isDraft: false,
              mergeable: "MERGEABLE",
              mergeStateStatus: "BLOCKED",
              reviewDecision: "REVIEW_REQUIRED",
            },
          },
        ],
      },
    };
    const node = {
      id: "PR_1",
      ...(counts ? { stack, stackEntry: { position: 2 } } : {}),
      number: 1,
      title: "A change",
      url: "https://github.com/example/app/pull/1",
      state: "OPEN",
      isDraft: false,
      createdAt: now,
      updatedAt: now,
      mergedAt: now,
      closedAt: now,
      headRefName: "change",
      bodyText: "",
      reviewDecision: "REVIEW_REQUIRED",
      mergeable: "MERGEABLE",
      repository: { nameWithOwner: "example/app" },
      author: { login: "someone" },
      reviews: { nodes: [] },
      reviewThreads: { nodes: [] },
      comments: { nodes: [] },
      commits: { nodes: [] },
      reviewRequests: { nodes: [{ requestedReviewer: { login: "me" } }] },
      timelineItems: { nodes: [] },
      ...counts,
    };
    const expected = counts
      ? { additions: counts.additions, deletions: counts.deletions, files: counts.changedFiles }
      : undefined;
    const client = (response: unknown) =>
      Gh.of({
        json: (args, schema) => {
          const query = args.join(" ");
          if (query.includes("MondashReviewDiscovery"))
            return Schema.decodeUnknownEffect(schema)({
              data: {
                viewer: { login: "me" },
                requested: { nodes: [{ id: node.id, author: node.author, reviewRequests: node.reviewRequests }] },
                team: { nodes: [] },
                reviewed: { nodes: [] },
                humans: { nodes: [] },
              },
            }).pipe(Effect.orDie);
          assert.match(query, /additions deletions changedFiles/);
          return Schema.decodeUnknownEffect(schema)(
            query.includes("MondashReviewDetails") ? { data: { nodes: [node] } } : response,
          ).pipe(Effect.orDie);
        },
      });
    const open = await getMyOpenPRs().pipe(
      Effect.provideService(
        Gh,
        client({
          data: { viewer: { login: "me" }, mine: { nodes: [node], pageInfo: { hasNextPage: false, endCursor: null } } },
        }),
      ),
      Effect.provide(Store.layerMemory),
      Effect.runPromise,
    );
    assert.deepEqual(open[0].changes, expected);
    const expectedStack = counts
      ? {
          number: 2500,
          position: 2,
          size: 2,
          base: "main",
          entries: [
            {
              position: 1,
              number: 2498,
              title: "Base PR",
              url: "https://github.com/example/app/pull/2498",
              status: "Conflicts",
            },
            {
              position: 2,
              number: 2499,
              title: "Top PR",
              url: "https://github.com/example/app/pull/2499",
              status: "Approval needed",
            },
          ],
        }
      : undefined;
    assert.deepEqual(open[0].stack, expectedStack);
    let pages = 0;
    const paginated = await getMyOpenPRs().pipe(
      Effect.provide(Store.layerMemory),
      Effect.provideService(
        Gh,
        Gh.of({
          json: (args, schema) => {
            const second = pages++ > 0;
            if (second) assert.ok(args.includes("after=older"));
            return Schema.decodeUnknownEffect(schema)({
              data: {
                viewer: { login: "me" },
                mine: {
                  nodes: [{ ...node, number: second ? 2 : 1, isDraft: second }],
                  pageInfo: { hasNextPage: !second, endCursor: second ? null : "older" },
                },
              },
            }).pipe(Effect.orDie);
          },
        }),
      ),
      Effect.runPromise,
    );
    assert.equal(pages, 2);
    assert.equal(paginated[1].isDraft, true);

    const merged = await getMyOtherPRs().pipe(
      Effect.provideService(
        Gh,
        client({
          data: {
            search: { nodes: [{ ...node, state: "MERGED" }], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        }),
      ),
      Effect.provide(Store.layerMemory),
      Effect.runPromise,
    );
    assert.deepEqual(merged[0].changes, expected);
    const reviews = await getReviewFeed().pipe(
      Effect.provideService(
        Gh,
        client({
          data: {
            viewer: { login: "me" },
            requested: { nodes: [node] },
            team: { nodes: [] },
            reviewed: { nodes: [] },
            humans: { nodes: [] },
          },
        }),
      ),
      Effect.provide(Store.layerMemory),
      Effect.runPromise,
    );
    assert.deepEqual(reviews.prs[0].changes, expected);
    assert.deepEqual(reviews.prs[0].stack, expectedStack);
  });
}

test("a person's reply needs you until you answer or resolve it", () => {
  const r = attention([thread(false, by("alice", "2026-09-01"))], undefined, "me");
  assert.deepEqual(r.reply?.from, ["alice"]);
  assert.equal(
    attention([thread(false, by("alice", "2026-09-01"), by("me", "2026-09-02"))], undefined, "me").reply,
    null,
  );
  assert.equal(attention([thread(true, by("alice", "2026-09-01"))], undefined, "me").reply, null);
});

test("replies are counted per waiting thread, newest person first", () => {
  const r = attention([thread(false, by("alice", "2026-09-01"))], by("bob", "2026-09-03"), "me");
  assert.deepEqual(r.reply?.from, ["bob", "alice"]);
  assert.equal(r.reply?.url, "u/bob/2026-09-03");
});

test("AI reviewer threads are counted apart; other bots are ignored", () => {
  const r = attention(
    [
      thread(false, by("coderabbitai", "2026-09-01", "Bot")),
      thread(false, by("greptile-apps", "2026-09-01", "Bot")),
      thread(false, by("greptile-apps", "2026-09-01", "Bot"), by("me", "2026-09-02")),
      thread(true, by("coderabbitai", "2026-09-01", "Bot")),
    ],
    by("gitguardian", "2026-09-04", "Bot"),
    "me",
  );
  assert.equal(r.aiThreads?.count, 2);
  assert.equal(r.reply, null);
});

test("one reviewer's four inline comments count as four replies from one person", () => {
  const threads = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"].map((at) =>
    thread(false, by("me", "2026-08-30"), by("morgan-demo", at)),
  );
  const r = attention(threads, undefined, "me");
  assert.equal(r.reply?.count, 4);
  assert.deepEqual(r.reply?.from, ["morgan-demo"]);
});

test("PR history retains merged and closed states across pages, skipping malformed and non-PR results", async () => {
  const merged = (number: number) => ({
    number,
    title: `PR ${number}`,
    url: `https://github.com/o/r/pull/${number}`,
    isDraft: false,
    state: "MERGED",
    createdAt: "2026-09-20T10:00:00Z",
    updatedAt: "2026-09-21T10:00:00Z",
    headRefName: `b${number}`,
    mergedAt: "2026-09-21T10:00:00Z",
    closedAt: "2026-09-21T10:00:00Z",
    commits: { nodes: [] },
    repository: { nameWithOwner: "o/r" },
  });
  const { title: _title, ...untitled } = merged(2);
  const closed = {
    ...merged(3),
    state: "CLOSED",
    isDraft: true,
    mergedAt: null,
    closedAt: "2026-09-22T10:00:00Z",
    updatedAt: "2026-09-23T10:00:00Z",
  };
  const older = {
    ...merged(4),
    mergedAt: "2026-09-01T10:00:00Z",
    closedAt: "2026-09-01T10:00:00Z",
    updatedAt: "2026-09-23T10:00:00Z",
  };
  let pages = 0;
  const gh = Gh.of({
    json: (_args, schema) => {
      const second = pages++ > 0;
      return Schema.decodeEffect(schema)({
        data: {
          search: {
            issueCount: 5,
            nodes: second ? [closed, older] : [merged(1), untitled, {}],
            pageInfo: { hasNextPage: !second, endCursor: second ? null : "older" },
          },
        },
      }).pipe(Effect.orDie);
    },
  });
  const warnings: unknown[] = [];
  const collect = Logger.make(({ logLevel, message }) => {
    if (logLevel === "Warn") warnings.push(message);
  });

  const prs = await Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-24T12:00:00Z"));
    return yield* getMyOtherPRs();
  }).pipe(
    Effect.provideService(Gh, gh),
    Effect.provide([Logger.layer([collect]), Store.layerMemory, TestClock.layer()]),
    Effect.runPromise,
  );

  assert.deepEqual(
    prs.map((pr) => pr.number),
    [1, 3],
  );
  assert.equal(pages, 2);
  assert.equal(prs[0].state, "MERGED");
  assert.equal(prs[0].review, "MERGED");
  assert.equal(prs[1].state, "CLOSED");
  assert.equal(prs[1].review, null);
  assert.equal(prs[1].updatedAt.toISOString(), "2026-09-22T10:00:00.000Z");
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]), /PR #2 .*title/s);
});

test("the GitHub refresh probe covers drafts beyond the first page", async () => {
  let pages = 0;
  const result = await probeGitHub().pipe(
    Effect.provideService(
      Gh,
      Gh.of({
        json: (args, schema) => {
          const second = pages++ > 0;
          assert.match(args.join(" "), /updatedAt isDraft mergeable/);
          if (second) assert.ok(args.includes("after=older"));
          return Schema.decodeUnknownEffect(schema)({
            data: {
              mine: {
                nodes: [{ url: second ? "older-draft" : "ready", isDraft: second }],
                pageInfo: { hasNextPage: !second, endCursor: second ? null : "older" },
              },
              requested: {},
              team: {},
              reviewed: {},
              humans: {},
            },
          }).pipe(Effect.orDie);
        },
      }),
    ),
    Effect.runPromise,
  );
  assert.equal(pages, 2);
  assert.equal(result[0].mine.nodes.length, 2);
});

test("overlapping review searches fetch each PR's nested threads only once", async () => {
  const pr = (number: number) => ({
    id: `PR_${number}`,
    number,
    title: `PR ${number}`,
    url: `https://github.com/o/r/pull/${number}`,
    state: "OPEN",
    isDraft: false,
    createdAt: "2026-10-05T09:00:00Z",
    headRefName: `b${number}`,
    bodyText: "",
    reviewDecision: "REVIEW_REQUIRED",
    author: { login: "someone" },
    repository: { nameWithOwner: "o/r" },
    commits: { nodes: [] },
    comments: { nodes: [] },
    reviews: { nodes: [] },
    reviewThreads: { nodes: [] },
    reviewRequests: { nodes: [{ requestedReviewer: { login: "me" } }] },
    timelineItems: { nodes: [] },
  });
  const reviewUrl = "https://github.com/o/r/pull/1#pullrequestreview-123";
  const commentUrl = "https://github.com/o/r/pull/1#discussion_r456";
  const nodes = [
    {
      ...pr(1),
      reviews: {
        nodes: [
          {
            author: { login: "someone", __typename: "User" },
            state: "COMMENTED",
            submittedAt: new Date().toISOString(),
            url: reviewUrl,
            comments: { nodes: [{ url: commentUrl }] },
          },
          {
            author: { login: "reviewer", __typename: "User" },
            state: "APPROVED",
            submittedAt: new Date().toISOString(),
            url: reviewUrl,
            comments: { nodes: [] },
          },
        ],
      },
    },
    pr(2),
  ];
  let detailCalls = 0;
  const result = await getReviewFeed().pipe(
    Effect.provideService(
      Gh,
      Gh.of({
        json: (args, schema) => {
          const query = args.find((a) => a.startsWith("query=")) ?? "";
          if (query.includes("reviewThreads")) {
            detailCalls++;
            const ids = JSON.parse(query.match(/nodes\(ids:\s*(\[[^\]]*\])/)?.[1] ?? "[]");
            assert.deepEqual(ids, ["PR_1", "PR_2"]);
            return Schema.decodeUnknownEffect(schema)({ data: { nodes } }).pipe(Effect.orDie);
          }
          return Schema.decodeUnknownEffect(schema)({
            data: {
              viewer: { login: "me" },
              requested: { nodes: [pr(1), { ...pr(4), author: { login: "me" } }] },
              team: { nodes: [pr(1)] },
              reviewed: { nodes: [pr(2)] },
              humans: { nodes: [pr(1), pr(2), { ...pr(3), reviewRequests: { nodes: [] } }] },
            },
          }).pipe(Effect.orDie);
        },
      }),
    ),
    Effect.provide(Store.layerMemory),
    Effect.runPromise,
  );
  assert.equal(detailCalls, 1);
  assert.deepEqual(result.seen.sort(), ["pr:o/r#1", "pr:o/r#2"]);
  assert.deepEqual(
    result.prs.find((pr) => pr.key === "r#1")?.reviews.map((review) => review.url),
    [commentUrl, reviewUrl],
    "inline reviews open the comment; reviews without inline comments open the review",
  );
});
