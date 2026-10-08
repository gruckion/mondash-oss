import assert from "node:assert/strict";
import { test } from "node:test";
import { warmDue } from "./dashboard";

const minutes = (n: number) => n * 60_000;

test("sections refresh every minute while someone looks, and every 15 minutes when nobody does", () => {
  const now = minutes(100);
  assert.equal(warmDue(now, now - minutes(2), now - minutes(1)), true);
  assert.equal(warmDue(now, now - minutes(30), now - minutes(5)), false);
  assert.equal(warmDue(now, now - minutes(30), now - minutes(15)), true);
});
