import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Logger, Schema } from "effect";
import { Gh } from "@/services/gh";
import { Store } from "@/services/store";
import { pullRequestsForSession } from "./session-prs";

test("session PRs retain merged work, deduplicate provider references, and reuse metadata across sessions despite a partial failure", async () => {
  const requests: number[] = [];
  const gh = Gh.of({
    json: (args, schema) => {
      const number = Number(args.find((arg) => arg.startsWith("number="))?.slice(7));
      requests.push(number);
      return Schema.decodeUnknownEffect(schema)({
        data: {
          repository: {
            pullRequest:
              number === 3
                ? null
                : {
                    title: number === 1 ? "Previous work" : "Current work",
                    headRefName: `branch-${number}`,
                    state: number === 1 ? "MERGED" : "OPEN",
                    isDraft: false,
                    updatedAt: "2026-10-06T12:00:00Z",
                    additions: 12,
                    deletions: 4,
                    changedFiles: 2,
                    author: { login: "alice", avatarUrl: "https://avatars.githubusercontent.com/u/1" },
                    commits: {
                      nodes: [
                        {
                          commit: {
                            statusCheckRollup: {
                              state: "PENDING",
                              contexts: {
                                totalCount: 3,
                                checkRunCountsByState: [{ state: "SUCCESS", count: 3 }],
                                statusContextCountsByState: [],
                              },
                            },
                          },
                        },
                      ],
                    },
                  },
          },
        },
      }).pipe(Effect.orDie);
    },
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* pullRequestsForSession({
        refs: { "pr:example/app#1": 3, "pr:example/app#2": 2, "pr:example/app#3": 1, "ticket:DEMO-1": 1 },
        linkedPRs: ["pr:EXAMPLE/app#2"],
      });
      assert.deepEqual(
        result.prs.map((pr) => [pr.number, pr.state, pr.unavailable]),
        [
          [2, "OPEN", undefined],
          [1, "MERGED", undefined],
          [3, undefined, true],
        ],
      );
      assert.equal(result.prs[0]?.title, "Current work");
      assert.equal(result.prs[0]?.checks, "PENDING");
      assert.deepEqual(result.prs[0]?.checksSummary, { passed: 3, failed: 0, pending: 0, skipped: 0 });
      assert.deepEqual(result.prs[0]?.changes, { additions: 12, deletions: 4, files: 2 });
      assert.equal(result.prs[0]?.author?.name, "alice");
      const other = yield* pullRequestsForSession({ refs: { "pr:example/app#2": 1 }, linkedPRs: [] });
      assert.equal(other.prs[0]?.title, "Current work");
      assert.equal(requests.filter((number) => number === 2).length, 1);
      assert.equal(result.truncated, false);
    }).pipe(Effect.provideService(Gh, gh), Effect.provide([Store.layerMemory, Logger.layer([])])),
  );
});

test("very long session reference lists cap provider reads and report omitted PRs", async () => {
  let reads = 0;
  const gh = Gh.of({
    json: (_args, schema) => {
      reads++;
      return Schema.decodeUnknownEffect(schema)({ data: { repository: null } }).pipe(Effect.orDie);
    },
  });
  const result = await Effect.runPromise(
    pullRequestsForSession({
      refs: Object.fromEntries(Array.from({ length: 35 }, (_, i) => [`pr:example/app#${i + 1}`, 1])),
    }).pipe(Effect.provideService(Gh, gh), Effect.provide([Store.layerMemory, Logger.layer([])])),
  );
  assert.equal(result.prs.length, 30);
  assert.equal(reads, 30);
  assert.equal(result.truncated, true);
});
