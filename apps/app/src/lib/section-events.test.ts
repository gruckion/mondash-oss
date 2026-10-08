import assert from "node:assert/strict";
import { test } from "node:test";
import { takeEvents } from "./section-events";

test("server-sent events are split into complete events, and a partial one waits for the rest", () => {
  const first = takeEvents('data: {"a":1}\n\n: alive\n\ndata: {"b"');
  assert.deepEqual(first.data, ['{"a":1}']);
  assert.equal(first.rest, 'data: {"b"');
  assert.deepEqual(takeEvents(`${first.rest}:2}\n\n`).data, ['{"b":2}']);
});
