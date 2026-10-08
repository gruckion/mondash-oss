import assert from "node:assert/strict";
import { test } from "node:test";
import { isRead, justBefore } from "./feed-tabs.ts";

test("your mark holds until the source's read state changes, then the source wins", () => {
  // Marked read in Mondash while Slack still said unread: stays read.
  assert.equal(isRead({ read: true, source: false }, false, false), true);
  // Then you read it in Slack, and later marked it unread there: Slack's change wins.
  assert.equal(isRead({ read: true, source: false }, true, false), true);
  assert.equal(isRead({ read: false, source: true }, false, true), false);
  assert.equal(isRead({ read: false, source: false }, true, false), true);
  // A source with no read state (Notion): your mark always holds.
  assert.equal(isRead({ read: true }, undefined, false), true);
  // No mark: the source, else the fallback.
  assert.equal(isRead(undefined, undefined, true), true);
  assert.equal(isRead(undefined, false, true), false);
});

test("marking unread sets Slack's marker one microsecond before the message", () => {
  assert.equal(justBefore("1790330313.334549"), "1790330313.334548");
  assert.equal(justBefore("1790330313.000000"), "1790330312.999999");
});
