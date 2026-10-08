import assert from "node:assert/strict";
import test from "node:test";
import type { Card, Row, Session } from "./contract";
import { hasStackPR, issueEntries, stackActivity } from "./issue-stacks";
import { applyView, DEFAULT_VIEW } from "./view-options";

const pr = (url: string, extra: Partial<Row> = {}): Row => ({ kind: "pr", title: url, url, prState: "OPEN", ...extra });
const core = pr("https://github.com/example/core/pull/2426");
const web = pr("https://github.com/example/web/pull/1954");
const card = (id: string, rows: readonly Row[], extra: Partial<Card> = {}): Card =>
  Object.freeze({
    id,
    kind: "issue",
    title: id,
    subtitle: "",
    status: "In Review",
    url: `https://linear.app/example/issue/${id}/title`,
    attention: [],
    labels: [],
    links: [],
    related: [],
    sessions: [],
    rows: Object.freeze([...rows]),
    ...extra,
  });
const cards = Object.freeze([card("DEMO-4225", [core, web]), card("DEMO-4209", [core]), card("DEMO-4208", [core])]);

test("stacking is opt-in, preserves ticket identities/order and includes extra PR coverage", () => {
  assert.deepEqual(
    issueEntries(cards, false),
    cards.map((card) => ({ card })),
  );
  const entries = issueEntries(cards, true);
  assert.equal(entries.length, 1);
  assert.ok("stack" in entries[0]);
  const { stack } = entries[0];
  assert.deepEqual(stack.cards, cards);
  assert.deepEqual(stack.prs, [core, web]);
  assert.deepEqual(
    stack.cards.filter((card) => hasStackPR(card, core)).map((card) => card.id),
    ["DEMO-4225", "DEMO-4209", "DEMO-4208"],
  );
  assert.deepEqual(
    stack.cards.filter((card) => hasStackPR(card, web)).map((card) => card.id),
    ["DEMO-4225"],
  );
  assert.equal(stack.cards[0], cards[0]);
});

test("only one directly shared open PR can anchor a group; a chain doesn't collapse transitively", () => {
  const input = [card("DEMO-1", [core]), card("DEMO-2", [core, web]), card("DEMO-3", [web])];
  const entries = issueEntries(input, true);
  assert.equal(entries.length, 2);
  assert.ok("stack" in entries[0] && "card" in entries[1]);
  assert.deepEqual(
    entries[0].stack.cards.map((card) => card.id),
    ["DEMO-1", "DEMO-2"],
  );
  assert.equal(entries[1].card, input[2]);
});

test("stacks keep open and draft PRs inline and fold merged and closed PRs into deduplicated history", () => {
  const old = "2026-10-01T12:00:00.000Z";
  const recent = "2026-10-02T12:00:00.000Z";
  const draft = pr(web.url, { prState: "DRAFT" });
  const merged = pr("https://github.com/example/core/pull/2400", { prState: "MERGED", updatedAt: old });
  const closed = pr("https://github.com/example/web/pull/1900", { prState: "CLOSED", updatedAt: old });
  const newerClosed = { ...closed, updatedAt: recent };
  const legacyClosed = pr("https://github.com/example/web/pull/1800", { prState: undefined, status: "Closed" });
  const input = [
    card("DEMO-1", [core, draft, merged, closed, legacyClosed]),
    card("DEMO-2", [core, newerClosed, merged]),
  ];
  const entry = issueEntries(input, true)[0];
  assert.ok("stack" in entry);
  assert.deepEqual(entry.stack.prs, [core, draft]);
  assert.deepEqual(stackActivity(input).otherPRs, [newerClosed, merged, legacyClosed]);
  assert.equal(input[0].rows?.[3].updatedAt, old);
});

test("PR identity includes owner/repository and ignores comment/diff URLs; closed/merged PRs don't create stacks", () => {
  const otherOwner = pr("https://github.com/elsewhere/core/pull/2426");
  assert.equal(issueEntries([card("DEMO-1", [core]), card("DEMO-2", [otherOwner])], true).length, 2);
  assert.equal(
    issueEntries([card("DEMO-1", [core]), card("DEMO-2", [pr(`${core.url}/files?x=1#comment`)])], true).length,
    1,
  );
  for (const row of [
    pr(core.url, { prState: "CLOSED" }),
    pr(core.url, { prState: "MERGED" }),
    pr(core.url, { merged: true }),
    pr(core.url, { prState: undefined, status: "MERGED" }),
    pr(core.url, { prState: undefined, status: "CLOSED" }),
  ]) {
    assert.equal(issueEntries([card("DEMO-1", [row]), card("DEMO-2", [row])], true).length, 2);
  }
  assert.equal(issueEntries([card("DEMO-1", [core]), card("DEMO-2", [core], { kind: "review" })], true).length, 2);
});

test("stacks respect filtering, sorting and section boundaries; unmatched tickets remain ordinary cards", () => {
  const input = [{ id: "Assigned", title: "Assigned", collapsed: false, cards }];
  const filtered = applyView("issues", input, { ...DEFAULT_VIEW, filters: { label: ["Prio"] } });
  assert.deepEqual(issueEntries(filtered[0].cards, true), []);
  const sorted = applyView("issues", input, { ...DEFAULT_VIEW, sort: "title" });
  const entry = issueEntries(sorted[0].cards, true)[0];
  assert.ok("stack" in entry);
  assert.deepEqual(
    entry.stack.cards.map((card) => card.id),
    ["DEMO-4208", "DEMO-4209", "DEMO-4225"],
  );
  assert.equal(issueEntries(cards.slice(0, 1), true).length, 1);
  assert.ok("card" in issueEntries(cards.slice(0, 1), true)[0]);
  assert.equal(issueEntries(cards.slice(1), true).length, 1);
});

test("shared activity dedupes Slack replies by thread and sessions by tool/id, keeping the newest snapshot", () => {
  const old = "2026-09-30T12:00:00.000Z",
    recent = "2026-10-01T12:00:00.000Z";
  const thread: Row = {
    kind: "slack",
    title: "#launch",
    url: "https://example.slack.com/archives/C123/p1770000000000001",
    updatedAt: old,
  };
  const reply: Row = {
    ...thread,
    url: "https://example.slack.com/archives/C123/p1770000000000002?thread_ts=1770000000.000001&cid=C123",
    updatedAt: recent,
  };
  const session: Session = { id: "shared", tool: "claude", title: "Old", canOpenOnMac: true, updatedAt: old };
  const newer = { ...session, title: "Newest", updatedAt: recent };
  const input = [
    card("DEMO-4225", [core, thread], { sessions: [session] }),
    card("DEMO-4209", [core, reply], { sessions: [newer] }),
    card("DEMO-4208", [core, thread], { sessions: [{ ...session, tool: "codex" }] }),
  ];
  const result = stackActivity(input);
  assert.deepEqual(result.threads, [reply]);
  assert.deepEqual(
    result.sessions.map((session) => `${session.tool}:${session.title}`),
    ["claude:Newest", "codex:Old"],
  );
  assert.equal(input[0].sessions[0].title, "Old");
});
