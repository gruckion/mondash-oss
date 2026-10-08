import assert from "node:assert/strict";
import { test } from "node:test";
import type { Connection } from "@mondash/shared/contract";
import { needsAttention, problemTitle, providerProblems } from "./provider-health";

const connection = (name: string, state: Connection["state"]): Connection => ({ name, state, checkedAt: null });

test("only failed providers appear, and healthy recovery removes the warning", () => {
  const names = ["linear", "slack", "notion", "github", "claude", "codex"];
  const failed = names.map((name) => connection(name, "error"));
  assert.deepEqual(
    providerProblems(failed).map((problem) => problem.name),
    names,
  );
  assert.ok(failed.every(needsAttention));
  const disconnected = names.map((name) => connection(name, "not-connected"));
  assert.equal(providerProblems(disconnected).length, 6);
  const recovered = names.map((name) => connection(name, "connected"));
  assert.equal(providerProblems(recovered).length, 0);
  assert.ok(recovered.every((one) => !needsAttention(one)));
  assert.equal(providerProblems(names.map((name) => connection(name, "unknown"))).length, 0);
  assert.equal(providerProblems([connection("sessions", "error")]).length, 0);
  assert.equal(needsAttention(connection("sessions", "error")), true);
});

test("provider help distinguishes a lost login from a failed refresh", () => {
  const [notion] = providerProblems([connection("notion", "not-connected")]);
  const [slack] = providerProblems([connection("slack", "error")]);
  assert.equal(problemTitle(notion!), "Notion disconnected");
  assert.equal(problemTitle(slack!), "Slack refresh failed");
});
