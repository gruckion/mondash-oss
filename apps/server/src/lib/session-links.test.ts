import assert from "node:assert/strict";
import { test } from "node:test";
import { explicitlyLinked, linkedPRRefs, worthAsking, sessionCandidates, selectSessionItems } from "./session-links.ts";

const id = "test-session";
const link = (pr: number) => ({ type: "pr-link", sessionId: id, prUrl: `https://github.com/example/app/pull/${pr}` });

test("reads agent PR associations, keeping multiple PRs and excluding foreign or incidental links", () => {
  assert.deepEqual(
    linkedPRRefs(
      [
        link(12),
        link(12),
        link(13),
        { ...link(14), sessionId: "other-session" },
        { type: "assistant", message: { content: "https://github.com/example/app/pull/15" } },
        { ...link(16), prUrl: "https://github.com.evil.example/example/app/pull/16" },
        { type: "pr-link", sessionId: id },
        null,
      ],
      id,
    ),
    ["pr:example/app#12", "pr:example/app#13"],
  );
});

test("Jev's score decides every candidate, including recorded and pasted PRs", () => {
  const items = [12, 13, 14].map((n) => ({ key: `PR${n}`, refs: [`pr:example/app#${n}`] }));
  const session = { refs: { "pr:example/app#14": 20 }, linkedPRs: linkedPRRefs([link(12), link(13)], id) };
  const found = sessionCandidates(items, session);
  assert.equal(found.length, 3, "metadata alone can make a PR a candidate");
  assert.deepEqual(
    selectSessionItems(found, { PR12: 0.9, PR13: 0.2, PR14: 0.7 }).map((i) => i.key),
    ["PR12", "PR14"],
  );
});

test("when Jev cannot score an item, no automatic link is kept", () => {
  const items = [12, 13].map((n) => ({ key: `PR${n}`, refs: [`pr:example/app#${n}`] }));
  const session = { refs: { "pr:example/app#12": 1, "pr:example/app#13": 1 }, linkedPRs: ["pr:example/app#12"] };
  const found = sessionCandidates(items, session);
  assert.deepEqual(
    selectSessionItems(found, {}).map((i) => i.key),
    [],
  );
});

test("a pasted link counts as explicit only for the item's own PRs", () => {
  const ticket = {
    key: "DEMO-1",
    refs: ["ticket:DEMO-1", "pr:example/app#12", "pr:example/app#99"],
    ownPRs: ["pr:example/app#12"],
  };
  const aboutReference = { refs: { "pr:example/app#99": 1 }, promptRefs: { "pr:example/app#99": 1 } };
  assert.equal(explicitlyLinked(ticket, aboutReference), false, "a PR only attached for reference");
  const aboutOwn = { refs: { "pr:example/app#12": 1 }, promptRefs: { "pr:example/app#12": 1 } };
  assert.equal(explicitlyLinked(ticket, aboutOwn), true);
  // Explicit or not, a score decides.
  assert.deepEqual(selectSessionItems([ticket], { "DEMO-1": 0.11 }), []);
});

test("an item is worth asking Jev about when you named it or the session keeps mentioning it", () => {
  const card = { key: "card", refs: ["notion:abc"] };
  assert.equal(worthAsking(card, { refs: { "notion:abc": 80 }, linkedPRs: [], promptRefs: {} }), true);
  assert.equal(worthAsking(card, { refs: { "notion:abc": 1 }, linkedPRs: [], promptRefs: { "notion:abc": 1 } }), true);
  assert.equal(worthAsking(card, { refs: { "notion:abc": 2 }, linkedPRs: [], promptRefs: {} }), false);
});
