import assert from "node:assert/strict";
import test from "node:test";
import type { Card, Row } from "./contract";
import { cardScope, inItemScope, itemUrlKey, rowScope } from "./linked-items";

const doc = "https://www.notion.so/Stripe-e0f15ad5d7b059ea8b9fa1710fbd7501";
const core: Row = { kind: "pr", title: "core#2426", url: "https://github.com/example/core/pull/2426" };
const web: Row = { kind: "pr", title: "web#1954", url: "https://github.com/example/web/pull/1954" };
const card = (id: string, rows: readonly Row[], extra: Partial<Card> = {}): Card => ({
  id,
  title: id,
  kind: "issue",
  subtitle: "",
  status: "In Review",
  attention: [],
  labels: [],
  links: [],
  sessions: [],
  related: [],
  rows,
  url: `https://linear.app/example/issue/${id}/original-title`,
  ...extra,
});
const tickets = [card("DEMO-4225", [core, web]), card("DEMO-4209", [core]), card("DEMO-4208", [core])];

test("PR and ticket hover scopes are bidirectional with exact coverage", () => {
  assert.deepEqual(
    tickets.map((ticket) => inItemScope(rowScope(core, tickets), cardScope(ticket))),
    [true, true, true],
  );
  assert.deepEqual(
    tickets.map((ticket) => inItemScope(rowScope(web, [tickets[0]]), cardScope(ticket))),
    [true, false, false],
  );
  assert.deepEqual(
    [core, web].map((row) => inItemScope(cardScope(tickets[0]), rowScope(row))),
    [true, true],
  );
  assert.deepEqual(
    [core, web].map((row) => inItemScope(cardScope(tickets[1]), rowScope(row))),
    [true, false],
  );
  assert.equal(inItemScope(cardScope(tickets[0]), cardScope(tickets[1])), false);
});

test("cross-column docs and issues highlight even if the explicit link exists only on one side", () => {
  const issue = card("DEMO-4225", [{ kind: "notion", title: "Stripe fee", url: doc }]);
  const scoping = card("doc", [], {
    kind: "scoping",
    url: "https://www.notion.so/E0F15AD5-D7B0-59EA-8B9F-A1710FBD7501?v=123#comment",
  });
  assert.equal(inItemScope(cardScope(issue), cardScope(scoping)), true);
  assert.equal(inItemScope(cardScope(scoping), cardScope(issue)), true);
  const reverse = card(
    "doc",
    [{ kind: "ticket", title: "DEMO-4225", url: "https://linear.app/example/issue/DEMO-4225/new-title" }],
    { kind: "scoping", url: doc },
  );
  assert.equal(inItemScope(cardScope(tickets[0]), cardScope(reverse)), true);
  assert.equal(inItemScope(cardScope(reverse), cardScope(tickets[0])), true);
});

test("sharing a neighbour doesn't invent doc-to-doc or PR-to-PR associations", () => {
  const a = card("doc-a", [{ kind: "ticket", title: "DEMO-4225", url: tickets[0].url! }], {
    kind: "scoping",
    url: doc,
  });
  const b = card("doc-b", a.rows!, { kind: "scoping", url: "https://www.notion.so/ff72d97bff72d97bff72d97bff72d97b" });
  assert.equal(inItemScope(cardScope(a), cardScope(b)), false);
  assert.equal(inItemScope(rowScope(core, tickets), rowScope(web, [tickets[0]])), false);
  assert.equal(inItemScope(null, cardScope(a)), false);
});

test("identities survive renamed slugs and comment URLs; suggested Slack links aren't linked tickets", () => {
  assert.equal(itemUrlKey(`${core.url}/files#comment`), itemUrlKey(core.url));
  assert.notEqual(itemUrlKey(core.url), itemUrlKey("https://github.com/other/core/pull/2426"));
  const suggested = rowScope({
    kind: "slack",
    title: "Found thread",
    url: "https://example.slack.com/archives/C123/p1770000000000001",
    linkTicketId: "DEMO-4225",
  });
  assert.equal(inItemScope(suggested, cardScope(tickets[0])), false);
});
