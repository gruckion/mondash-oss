import assert from "node:assert/strict";
import { test } from "node:test";
import type { Card } from "@mondash/shared/contract";
import { attachReviewSessions, type ReviewSessionLink } from "./review-sessions.ts";

const first = "https://github.com/ExampleOrg/core/pull/1";
const second = "https://github.com/ExampleOrg/web/pull/2";
const card = (url: string): Card => ({
  id: url,
  kind: "review",
  url,
  title: "PR",
  subtitle: "",
  status: "",
  attention: [],
  labels: [],
  links: [],
  related: [],
  sessions: [],
});
test("one launched review is associated with every included PR without duplicate sessions", () => {
  const cards = [card(first), card(second), card("https://github.com/ExampleOrg/web/pull/3")];
  const groups = [{ id: "review", title: "", collapsed: false, cards }];
  const launch: ReviewSessionLink = {
    sessionId: "a",
    urls: [first, second],
    title: "PR risk review",
    createdAt: "2026-09-24T12:00:00Z",
    state: "ready",
  };
  const [twice] = attachReviewSessions(attachReviewSessions(groups, [launch]), [launch]);
  assert.deepEqual(
    twice.cards.map((item) => item.sessions.length),
    [1, 1, 0],
  );
  assert.equal(twice.cards[0].sessions[0].tool, "claude");
});
test("a pending launch keeps the Review action available for retry", () => {
  const item = card(first);
  const [group] = attachReviewSessions(
    [{ id: "review", title: "", collapsed: false, cards: [item] }],
    [{ sessionId: "a", urls: [first], title: "PR risk review", createdAt: "2026-09-24T12:00:00Z", state: "starting" }],
  );
  assert.deepEqual(group.cards[0].sessions, []);
});

test("review launch enrichment preserves Jev relevance before recency", () => {
  const session = (id: string, jev: number, updatedAt: string) => ({
    id,
    tool: "claude" as const,
    title: id,
    jev,
    updatedAt,
    canOpenOnMac: true,
  });
  const sessions = [session("relevant", 0.95, "2026-09-23T12:00:00Z"), session("recent", 0.75, "2026-09-24T12:00:00Z")];
  const groups = [{ id: "review", title: "", collapsed: false, cards: [{ ...card(first), sessions }] }];
  assert.deepEqual(
    attachReviewSessions(groups, [])[0].cards[0].sessions.map((s) => s.id),
    ["relevant", "recent"],
  );
});
