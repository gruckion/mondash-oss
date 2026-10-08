import assert from "node:assert/strict";
import { test } from "node:test";
import { codexRunning } from "./session-activity";

const event = (type: string) => ({ type: "event_msg", payload: { type } });

test("Codex activity follows native starts, completion and interruption, not message timestamps", () => {
  assert.equal(
    codexRunning([{ timestamp: new Date().toISOString(), type: "response_item", payload: { type: "message" } }]),
    undefined,
  );
  assert.equal(codexRunning([event("task_started"), event("token_count")]), true);
  for (const terminal of ["task_complete", "task_failed", "turn_aborted"])
    assert.equal(codexRunning([event("task_started"), event(terminal)]), false);
  assert.equal(codexRunning([event("task_complete"), event("task_started")]), true);
  assert.equal(codexRunning([event("token_count")], true), true);
});
