import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationTurn } from "@mondash/shared/contract";
import { conversationItems } from "./conversation";

test("completed progress collapses above its own final reply, keeping prompts and live work visible", () => {
  const context: ConversationTurn = { role: "user", text: "Use bun", context: "AGENTS.md" };
  const prompt: ConversationTurn = { role: "user", text: "Fix the build" };
  const progress: ConversationTurn = { role: "assistant", text: "Checking", phase: "commentary" };
  const command: ConversationTurn = {
    role: "assistant",
    text: "exec",
    activity: { id: "check", name: "exec", input: "bun test", status: "completed" },
  };
  const final: ConversationTurn = { id: "answer", role: "assistant", text: "Fixed", phase: "final" };
  const followup: ConversationTurn = { role: "user", text: "Check again" };
  const live: ConversationTurn = { role: "assistant", text: "Running checks", phase: "commentary" };
  const before = conversationItems([context, prompt, progress, command]);
  assert.deepEqual(
    before.map((item) => item.kind),
    ["message", "message", "message", "message"],
  );
  const after = conversationItems([context, prompt, progress, command, final, followup, live]);
  assert.deepEqual(after, [
    { kind: "message", turn: context },
    { kind: "message", turn: prompt },
    { kind: "work", id: "work:answer", turns: [progress, command] },
    { kind: "message", turn: final },
    { kind: "message", turn: followup },
    { kind: "message", turn: live },
  ]);
  const nextFinal: ConversationTurn = { id: "next-answer", role: "assistant", text: "Passed", phase: "final" };
  const completed = conversationItems([context, prompt, progress, command, final, followup, live, nextFinal]);
  assert.deepEqual(completed.slice(-2), [
    { kind: "work", id: "work:next-answer", turns: [live] },
    { kind: "message", turn: nextFinal },
  ]);
  assert.deepEqual(completed.slice(0, 4), after.slice(0, 4));
});

test("interrupted and unclassified replies remain accessible without an invented completion", () => {
  const turns: ConversationTurn[] = [
    { role: "user", text: "Start" },
    { role: "assistant", text: "Checking", phase: "commentary" },
    { role: "user", text: "Stop that" },
    { role: "assistant", text: "Stopped" },
  ];
  assert.deepEqual(
    conversationItems(turns),
    turns.map((turn) => ({ kind: "message", turn })),
  );
});

test("edited-file summaries stay with their own final answer even when command history collapses", () => {
  const edit = {
    file: { id: "source", name: "threshold.ts", kind: "file" as const },
    diff: "-old\n+new",
    additions: 1,
    deletions: 1,
  };
  const command: ConversationTurn = {
    role: "assistant",
    text: "exec",
    edits: [edit],
    activity: { id: "edit", name: "exec", input: "patch", status: "completed" },
  };
  const result = conversationItems([
    { role: "user", text: "Change threshold" },
    command,
    {
      ...command,
      edits: [{ ...edit, diff: "@@ -3,1 +3,1 @@\n-next\n+updated", additions: 2, deletions: 1 }],
    },
    { id: "first", role: "assistant", text: "Changed", phase: "final" },
    { role: "user", text: "Explain" },
    { id: "next", role: "assistant", text: "Explained", phase: "final" },
  ]);
  assert.equal(result[1]?.kind, "work");
  const answer = result[2];
  const next = result[4];
  assert.ok(answer?.kind === "message");
  assert.deepEqual(answer.turn.edits, [
    { ...edit, diff: "-old\n+new\n@@ -3,1 +3,1 @@\n-next\n+updated", additions: 3, deletions: 2 },
  ]);
  assert.ok(next?.kind === "message");
  assert.equal(next.turn.edits, undefined);
});
