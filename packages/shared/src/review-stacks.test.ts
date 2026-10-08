import assert from "node:assert/strict";
import { test } from "node:test";
import type { Card, Group, PRStack } from "./contract.ts";
import { groupReviewStacks, reviewStackLayout } from "./review-stacks.ts";
import { applyView, DEFAULT_VIEW } from "./view-options.ts";

const url = (repo: string, number: number, owner = "example") => `https://github.com/${owner}/${repo}/pull/${number}`;
const stack: PRStack = {
  number: 2502,
  position: 1,
  size: 4,
  base: "main",
  entries: [2474, 2501, 2460, 2465].map((number, i) => ({
    number,
    position: i + 1,
    title: `PR ${number}`,
    url: url("core", number),
    status: i < 2 ? "Approval needed" : "Draft",
  })),
};
const card = (repo: string, number: number, pair: string, extra: Partial<Card> = {}): Card => ({
  id: `${repo}#${number}`,
  prKey: `${repo}#${number}`,
  title: `PR ${number}`,
  subtitle: `example/${repo}`,
  url: url(repo, number),
  kind: "review",
  status: "Review requested",
  reviewGroupId: pair,
  attention: [],
  labels: [],
  links: [],
  sessions: [],
  related: [],
  ...extra,
});
const group = (id: string, cards: readonly Card[]): Group => ({
  id,
  title: "",
  presentation: "review-group",
  collapsed: false,
  cards,
});
const paired = () => [
  group("second", [card("core", 2501, "second", { stack: { ...stack, position: 2 } }), card("web", 2021, "second")]),
  group("first", [card("core", 2474, "first", { stack }), card("web", 1993, "first")]),
];

test("native stack layers stay base upwards, paired PRs appear once, drafts remain folded context", () => {
  const result = groupReviewStacks(paired())[0];
  const layout = reviewStackLayout([...result.cards].reverse(), result.reviewStacks)!;
  assert.deepEqual(
    layout.layers.map((layer) => layer.cards.map((card) => card.id)),
    [
      ["core#2474", "web#1993"],
      ["core#2501", "web#2021"],
    ],
  );
  assert.deepEqual(
    layout.others.map((entry) => [entry.number, entry.status]),
    [
      [2460, "Draft"],
      [2465, "Draft"],
    ],
  );
});

test("a repository filter preserves the stack and positions of paired PRs; an empty filtered group disappears", () => {
  const grouped = groupReviewStacks(paired());
  const filtered = applyView("reviews", grouped, { ...DEFAULT_VIEW, filters: { repo: ["web"] } })[0];
  assert.equal(filtered.cards.length, 2);
  const layout = reviewStackLayout(filtered.cards, filtered.reviewStacks)!;
  assert.deepEqual(
    layout.layers.map((layer) => [layer.position, layer.cards.map((card) => card.id)]),
    [
      [1, ["web#1993"]],
      [2, ["web#2021"]],
    ],
  );
  assert.ok(layout.others.some((entry) => entry.number === 2465));
  const empty = applyView("reviews", grouped, { ...DEFAULT_VIEW, filters: { repo: ["other"] } })[0];
  assert.equal(empty.cards.length, 0);
});

test("equal stack numbers from different repositories or owners never combine", () => {
  const groups = ["example/core", "example/web", "another/core"].map((repo, i) => {
    const [owner, name] = repo.split("/");
    const link = url(name, 10, owner);
    return group(`g${i}`, [
      card(name, 10, `g${i}`, { url: link, stack: { ...stack, entries: [{ ...stack.entries[0], url: link }] } }),
    ]);
  });
  assert.equal(groupReviewStacks(groups).length, 3);
});

test("a member whose own stack metadata is absent joins through the native stack's entry URL", () => {
  const [second, first] = paired();
  const result = groupReviewStacks([
    { ...second, cards: second.cards.map((card) => ({ ...card, stack: undefined })) },
    first,
  ]);
  assert.equal(result.length, 1);
  assert.equal(reviewStackLayout(result[0].cards, result[0].reviewStacks)?.layers.length, 2);
});

test("overlapping native stacks on paired repositories form one group without duplicate companion PRs", () => {
  const groups = paired().map((group) => ({
    ...group,
    cards: group.cards.map((card) =>
      card.id.startsWith("web")
        ? {
            ...card,
            stack: {
              number: 2027,
              position: card.id === "web#1993" ? 1 : 2,
              size: 2,
              base: "main",
              entries: [1993, 2021].map((number, i) => ({
                number,
                position: i + 1,
                title: `Web ${number}`,
                url: url("web", number),
                status: "Approval needed" as const,
              })),
            },
          }
        : card,
    ),
  }));
  const result = groupReviewStacks(groups);
  assert.equal(result.length, 1);
  const layout = reviewStackLayout(result[0].cards, result[0].reviewStacks)!;
  assert.deepEqual(
    layout.layers.map((layer) => layer.cards.map((card) => card.id)),
    [
      ["core#2474", "web#1993"],
      ["core#2501", "web#2021"],
    ],
  );
  assert.deepEqual(
    layout.others.map((entry) => entry.number),
    [2460, 2465],
  );
});

test("a shared Linear ticket across native layers uses explicit companion links, or leaves ambiguous PRs separate", () => {
  const all = paired()
    .flatMap((group) => group.cards)
    .map((card) => ({
      ...card,
      reviewGroupId: "shared-ticket",
      reviewCompanions:
        card.id === "core#2474" ? [url("web", 1993)] : card.id === "core#2501" ? [url("web", 2021)] : [],
    }));
  const result = groupReviewStacks([group("shared-ticket", all)])[0];
  assert.deepEqual(
    reviewStackLayout(result.cards, result.reviewStacks)?.layers.map((layer) => layer.cards.map((card) => card.id)),
    [
      ["core#2474", "web#1993"],
      ["core#2501", "web#2021"],
    ],
  );
  const ambiguous = groupReviewStacks([
    group(
      "shared-ticket",
      all.map((card) => ({ ...card, reviewCompanions: [] })),
    ),
  ])[0];
  const layers = reviewStackLayout(ambiguous.cards, ambiguous.reviewStacks)!.layers;
  assert.deepEqual(
    layers.filter((layer) => layer.position).map((layer) => layer.cards.map((card) => card.id)),
    [["core#2474"], ["core#2501"]],
  );
  assert.deepEqual(
    layers.filter((layer) => !layer.position).flatMap((layer) => layer.cards.map((card) => card.id)),
    ["web#2021", "web#1993"],
  );
});

test("the primary stack stays stable when one repository has two stacks in the same action group", () => {
  const native = (number: number, members: number[]): PRStack => ({
    number,
    size: members.length,
    position: 1,
    base: "main",
    entries: members.map((number, i) => ({
      number,
      position: i + 1,
      title: `PR ${number}`,
      url: url("core", number),
      status: "Approval needed",
    })),
  });
  const first = native(1, [10, 11]);
  const second = native(2, [20, 21, 22]);
  const result = groupReviewStacks([
    group("pair", [
      card("core", 10, "pair", { stack: first }),
      card("core", 20, "pair", { stack: second }),
      card("core", 21, "pair", { stack: { ...second, position: 2 } }),
    ]),
  ])[0];
  const layout = reviewStackLayout(result.cards, result.reviewStacks)!;
  assert.equal(layout.stack.number, 2);
  assert.deepEqual(
    layout.layers.map((layer) => [layer.position, layer.cards.map((card) => card.id)]),
    [
      [1, ["core#20"]],
      [2, ["core#21"]],
      [undefined, ["core#10"]],
    ],
  );
});
