import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Effect } from "effect";
import { Store } from "@/services/store";
import { openClaudeSession } from "./dashboard-actions";
import type { ClaudeReviewLaunch } from "./claude-review";

test("a newly launched review opens by its recorded identity before a transcript exists", async () => {
  const sessionId = randomUUID();
  const record: ClaudeReviewLaunch = {
    launchId: randomUUID(),
    sessionId,
    state: "ready",
    createdAt: new Date().toISOString(),
    cwd: "/tmp",
    urls: ["https://github.com/ExampleOrg/core/pull/2519"],
    title: "PR risk review",
  };
  const opened: unknown[] = [];
  await Effect.runPromise(
    openClaudeSession(
      sessionId,
      "claude-desktop",
      async (...args) => {
        opened.push(args);
      },
      [record],
    ).pipe(Effect.provide(Store.layerMemory)),
  );
  assert.deepEqual(opened, [[sessionId, "/tmp", "claude-desktop"]]);
});
