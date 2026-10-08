import assert from "node:assert/strict";
import test from "node:test";
import { applyView, DEFAULT_VIEW, viewOptionsFor, isFiltered, propertyValues } from "./view-options.ts";
import type { Card, Group } from "./contract.ts";

const card = (id: string, extra: Partial<Card>): Card => ({
  id,
  title: id,
  subtitle: "",
  status: "Todo",
  kind: "issue",
  attention: [],
  labels: [],
  links: [],
  sessions: [],
  related: [],
  ...extra,
});
const groups: readonly Group[] = [
  {
    id: "g",
    title: "Assigned",
    collapsed: false,
    cards: [
      card("a", { priority: "Low", priorityValue: 4, labels: ["Billing"] }),
      card("b", { priority: "Urgent", priorityValue: 1, status: "In Progress", labels: ["Bug", "Billing"] }),
      card("c", { labels: [] }),
    ],
  },
];

test("Sessions archive and tool filters combine, with All restoring archived matches", () => {
  const session = {
    id: "s",
    tool: "codex" as const,
    title: "s",
    updatedAt: "2026-10-03T10:00:00Z",
    canOpenOnMac: false,
  };
  const data = [
    {
      id: "sessions",
      title: "Sessions",
      collapsed: false,
      cards: [
        card("active", { kind: "session", subtitle: "Codex", sessions: [session] }),
        card("archived", { kind: "session", subtitle: "Codex", sessions: [{ ...session, archived: true }] }),
        card("claude", {
          kind: "session",
          subtitle: "Claude Code",
          sessions: [{ ...session, tool: "claude" as const }],
        }),
      ],
    },
  ];
  const ids = (view = viewOptionsFor("sessions")) =>
    applyView("sessions", data, view).flatMap((g) => g.cards.map((c) => c.id));
  assert.deepEqual(ids(), ["active", "claude"]);
  assert.deepEqual(ids({ ...DEFAULT_VIEW, filters: { archive: ["Archived"], tool: ["Codex"] } }), ["archived"]);
  assert.deepEqual(ids({ ...DEFAULT_VIEW, filters: { archive: [] } }), ["active", "archived", "claude"]);
});

test("filters keep cards with a chosen value for every filtered property", () => {
  const ids = (options = DEFAULT_VIEW) => applyView("issues", groups, options)[0].cards.map((c) => c.id);
  assert.deepEqual(ids(), ["b", "a", "c"]);
  assert.deepEqual(ids({ ...DEFAULT_VIEW, filters: { label: ["Billing"] } }), ["b", "a"]);
  assert.deepEqual(ids({ ...DEFAULT_VIEW, filters: { label: ["Billing"], status: ["Todo"] } }), ["a"]);
  assert.deepEqual(ids({ ...DEFAULT_VIEW, filters: { priority: ["No priority"] } }), ["c"]);
});

test("priority sort puts cards with no priority last", () => {
  const ids = applyView("issues", groups, { ...DEFAULT_VIEW, sort: "priority" })[0].cards.map((c) => c.id);
  assert.deepEqual(ids, ["b", "a", "c"]);
});

test("Issues put In Progress before Todo at equal priority, including older cached Linear order", () => {
  const assigned: readonly Group[] = [
    {
      id: "assigned",
      title: "Assigned",
      collapsed: false,
      cards: [
        card("DEMO-3973", { priorityValue: 2, status: "Todo", statusType: "unstarted" }),
        card("DEMO-4174", { priorityValue: 2, status: "In Progress", statusType: "started" }),
        card("urgent-todo", { priorityValue: 1, status: "Todo", statusType: "unstarted" }),
        card("custom-started", { priorityValue: 2, status: "In Review", statusType: "started" }),
        card("older-started", { priorityValue: 2, status: "In Progress" }),
        card("low-started", { priorityValue: 4, status: "In Progress", statusType: "started" }),
      ],
    },
  ];
  for (const sort of ["default", "priority"]) {
    assert.deepEqual(
      applyView("issues", assigned, { ...DEFAULT_VIEW, sort })[0].cards.map((c) => c.id),
      ["urgent-todo", "DEMO-4174", "custom-started", "older-started", "DEMO-3973", "low-started"],
    );
  }
  assert.equal(assigned[0].cards[0].id, "DEMO-3973", "sorting leaves cached snapshots immutable");
  assert.equal(applyView("scoping", assigned, { ...DEFAULT_VIEW, sort: "priority" })[0].cards[1].id, "DEMO-3973");
});

test("review groups sort by their first card", () => {
  const pair = (id: string, at: string): Group => ({
    id,
    title: "",
    collapsed: false,
    presentation: "review-group",
    cards: [card(id, { updatedAt: at })],
  });
  const sorted = applyView(
    "reviews",
    [pair("old", "2026-09-01T00:00:00.000Z"), pair("new", "2026-09-20T00:00:00.000Z")],
    { ...DEFAULT_VIEW, sort: "recent" },
  );
  assert.deepEqual(
    sorted.map((g) => g.id),
    ["new", "old"],
  );
});

test("property values count each card once, most common first", () => {
  assert.deepEqual(
    propertyValues("issues", "label", groups).map(({ value, count }) => ({ value, count })),
    [
      { value: "Billing", count: 2 },
      { value: "Bug", count: 1 },
    ],
  );
});

test("hide approved PRs includes individual approvals even when GitHub still requires reviews", () => {
  const reviews: readonly Group[] = [
    {
      id: "reviews",
      title: "",
      collapsed: false,
      presentation: "review-group",
      cards: [
        card("overall", { kind: "review", reviewDecision: "APPROVED" }),
        card("another-person", {
          kind: "review",
          reviewDecision: "REVIEW_REQUIRED",
          badges: [{ text: "approved by Riley", tone: "green" }],
        }),
        card("mine", { kind: "review", badges: [{ text: "you approved", tone: "green" }] }),
        card("cached", { kind: "review", badges: [{ text: "approved", tone: "green" }] }),
        card("commented", { kind: "review", badges: [{ text: "commented by Riley", tone: "neutral" }] }),
        card("changes", {
          kind: "review",
          reviewDecision: "CHANGES_REQUESTED",
          badges: [{ text: "changes requested by Riley", tone: "red" }],
        }),
        card("unreviewed", { kind: "review" }),
      ],
    },
  ];
  const options = { ...DEFAULT_VIEW, filters: { approval: ["Not approved"] } };
  assert.equal(isFiltered(options), true);
  assert.deepEqual(
    applyView("reviews", reviews, options)[0].cards.map((c) => c.id),
    ["commented", "changes", "unreviewed"],
  );
  assert.equal(applyView("reviews", reviews, DEFAULT_VIEW)[0].cards.length, 7, "switching off restores approved PRs");
  assert.equal(applyView("issues", reviews, options)[0].cards.length, 7, "the filter only affects Reviews");
});

test("approval filtering composes with waiting, author and repository within PR pairs", () => {
  const review = (id: string, extra: Partial<Card> = {}) =>
    card(id, {
      kind: "review",
      status: "Review requested",
      author: { name: "Riley" },
      prKey: `org/web#${id}`,
      ...extra,
    });
  const reviews: readonly Group[] = [
    {
      id: "pair",
      title: "One change",
      collapsed: false,
      presentation: "review-group",
      cards: [
        review("approved", { badges: [{ text: "approved by Renée", tone: "green" }] }),
        review("keep"),
        review("other-author", { author: { name: "Renée" } }),
        review("other-repo", { prKey: "org/core#1" }),
        review("other-waiting", { status: "Reply waiting" }),
      ],
    },
  ];
  const filters = { waiting: ["Review requested"], author: ["Riley"], repo: ["org/web"] };
  const ids = (approval: string[]) =>
    applyView("reviews", reviews, { ...DEFAULT_VIEW, filters: { ...filters, approval } })[0].cards.map((c) => c.id);
  assert.deepEqual(ids(["Not approved"]), ["keep"]);
  assert.deepEqual(ids([]), ["approved", "keep"], "other filters remain active when the switch is off");
});
