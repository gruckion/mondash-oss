import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Logger, Schema } from "effect";
import { Group } from "@mondash/shared/contract";
import { Gh, makeGh } from "@/services/gh";
import { ReadOnly, Store } from "@/services/store";
import { sessionPRStatuses } from "./session-pr-statuses";
import { sessionGroups } from "./presenters";
import type { AgentSession } from "./sessions";

test("sidebar statuses retain open, draft, merged and closed PRs across sessions, omit inaccessible PRs and reuse a batch", async () => {
  let reads = 0;
  const gh = Gh.of({
    json: (_args, schema) => {
      reads++;
      return Schema.decodeUnknownEffect(schema)({
        data: {
          p0: { pullRequest: { title: "Current change", state: "OPEN", isDraft: false } },
          p1: { pullRequest: { title: "Work in progress", state: "OPEN", isDraft: true } },
          p2: { pullRequest: { title: "Previous change", state: "MERGED", isDraft: false } },
          p3: { pullRequest: { title: "Abandoned change", state: "CLOSED", isDraft: false } },
          p4: { pullRequest: null },
        },
      }).pipe(Effect.orDie);
    },
  });
  const sessions: AgentSession[] = [
    {
      firstPrompt: "",
      lastPrompt: "",
      cwd: "/project",
      promptRefs: {},
      id: "one",
      tool: "codex",
      title: "One",
      updatedAt: new Date("2026-10-06T12:00:00Z"),
      refs: {
        "pr:example/app#1": 1,
        "pr:example/app#2": 2,
        "pr:example/app#3": 1,
        "pr:example/app#4": 1,
        "pr:example/app#5": 1,
      },
      linkedPRs: ["pr:EXAMPLE/app#1"],
    },
    {
      firstPrompt: "",
      lastPrompt: "",
      cwd: "/project",
      promptRefs: {},
      id: "two",
      tool: "claude",
      title: "Two",
      updatedAt: new Date("2026-10-06T12:00:00Z"),
      refs: { "pr:example/app#3": 1 },
    },
    {
      firstPrompt: "",
      lastPrompt: "",
      cwd: "/project",
      promptRefs: {},
      id: "none",
      tool: "codex",
      title: "None",
      updatedAt: new Date("2026-10-06T12:00:00Z"),
      refs: {},
    },
  ];
  await Effect.runPromise(
    Effect.gen(function* () {
      const statuses = yield* sessionPRStatuses(sessions);
      const groups = sessionGroups(sessions, statuses);
      const transported = yield* Schema.decodeUnknownEffect(Schema.Array(Group))(groups);
      assert.deepEqual(
        transported[0]?.cards[0]?.sessions[0]?.pullRequests?.map((pr) => [pr.title, pr.state]),
        [
          ["Current change", "OPEN"],
          ["Work in progress", "DRAFT"],
          ["Previous change", "MERGED"],
          ["Abandoned change", "CLOSED"],
        ],
      );
      assert.equal(transported[0]?.cards[1]?.sessions[0]?.pullRequests?.[0]?.state, "MERGED");
      assert.deepEqual(transported[0]?.cards[2]?.sessions[0]?.pullRequests, []);
      assert.equal(statuses.size, 4);
      yield* sessionPRStatuses([...sessions].reverse());
      assert.equal(reads, 1, "list reordering reuses metadata instead of issuing per-row GitHub requests");
    }).pipe(Effect.provideService(Gh, gh), Effect.provide([Store.layerMemory, Logger.layer([])])),
  );
});

test("local sidebar reads do not wait for GitHub and background status loading preserves valid aliases beside a missing repository", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let reads = 0;
      const gh = yield* makeGh(async () => {
        reads++;
        throw Object.assign(new Error("GraphQL field error"), {
          stdout:
            "HTTP/2.0 200 OK\r\nX-RateLimit-Resource: graphql\r\nX-RateLimit-Remaining: 4000\r\n\r\n" +
            JSON.stringify({
              data: { p0: { pullRequest: { title: "Available change", state: "MERGED", isDraft: false } }, p1: null },
              errors: [{ type: "NOT_FOUND", path: ["p1"], message: "Could not resolve to a Repository" }],
            }),
          stderr: "gh: Could not resolve to a Repository",
        });
      });
      const session: AgentSession = {
        id: "one",
        tool: "codex",
        title: "One",
        firstPrompt: "",
        lastPrompt: "",
        cwd: "/project",
        promptRefs: {},
        updatedAt: new Date("2026-10-06T12:00:00Z"),
        refs: { "pr:example/app#1": 1, "pr:missing/app#1": 1 },
      };
      const load = sessionPRStatuses([session]).pipe(Effect.provideService(Gh, gh));
      assert.equal((yield* load.pipe(Effect.provideService(ReadOnly, true))).size, 0);
      assert.equal(reads, 0, "an uncached local session list never starts a provider request");
      const warmed = yield* load;
      assert.equal(warmed.get("https://github.com/example/app/pull/1")?.state, "MERGED");
      assert.equal(warmed.size, 1);
      const sidebar = yield* load.pipe(Effect.provideService(ReadOnly, true));
      assert.equal(sidebar.get("https://github.com/example/app/pull/1")?.title, "Available change");
      assert.equal(reads, 1);
    }).pipe(Effect.provide([Store.layerMemory, Logger.layer([])])),
  );
});
