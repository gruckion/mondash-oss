// Run: node --test src/lib/refs.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { addRefs, candidates, countRefs, refKeys, refLabel } from "./refs.ts";

test("counts tickets, branches, PRs, Slack threads and Notion pages", () => {
  const refs = countRefs(`
    Working on DEMO-4188 in branch demo-4188-cancel-appointments. See https://github.com/ExampleOrg/core/pull/2231
    and https://github.com/ExampleOrg/core/pull/2231 again. Like demo-4148 did.
    Thread https://examplehq.slack.com/archives/CDEMO45FBCE/p1789747637478879?thread_ts=1789747637.478879&cid=CDEMO45FBCE
    Reply https://examplehq.slack.com/archives/CDEMO45FBCE/p1789750000000000?thread_ts=1789747637.478879
    Card https://app.notion.com/p/Stripe-Application-Fee-e0f15ad5d7b059ea8b9fa1710fbd7501?source=copy_link`);
  assert.equal(refs["ticket:DEMO-4188"], 2);
  assert.equal(refs["ticket:DEMO-4148"], 1);
  assert.equal(refs["pr:ExampleOrg/core#2231"], 2);
  assert.equal(refs["slack:CDEMO45FBCE/1789747637.478879"], 2, "a reply counts for its thread");
  assert.equal(refs["notion:e0f15ad5d7b059ea8b9fa1710fbd7501"], 1);
});

test("a ticket's own links give the same keys as mentions of them", () => {
  assert.deepEqual(refKeys("https://examplehq.slack.com/archives/CDEMO45FBCE/p1789747637478879"), [
    "slack:CDEMO45FBCE/1789747637.478879",
  ]);
  assert.equal(refLabel("pr:ExampleOrg/web#1792"), "web#1792");
});

test("an item is a candidate when the session mentions any of its references, even once", () => {
  const items = [
    { id: "DEMO-4188", refs: ["ticket:DEMO-4188", "pr:ExampleOrg/core#2231"] },
    { id: "DEMO-4148", refs: ["ticket:DEMO-4148"] },
    { id: "DEMO-3824", refs: ["ticket:DEMO-3824"] },
  ];
  const session = { "pr:ExampleOrg/core#2231": 101, "ticket:DEMO-4148": 2 };
  assert.deepEqual(
    candidates(items, session).map((i) => i.id),
    ["DEMO-4188", "DEMO-4148"],
  );
});

test("counts from a session's files add up", () => {
  assert.deepEqual(addRefs({ a: 1, b: 2 }, { b: 3, c: 4 }), { a: 1, b: 5, c: 4 });
});
