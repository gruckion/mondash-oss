import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActivityEntity, ActivityEvent, Card } from "./contract";
import { activityAttentionSignature, activityEntities, activityTrails, filterActivity } from "./activity";

const entity = (
  id: string,
  kind: Card["kind"],
  workIds: readonly string[],
  patch: Partial<Card> = {},
): ActivityEntity => ({
  id,
  source: kind === "scoping" ? "notion" : kind === "issue" ? "linear" : kind === "session" ? "codex" : "github",
  inCurrentWork: true,
  workIds,
  card: {
    id,
    kind,
    title: id,
    subtitle: "",
    status: "",
    attention: [],
    labels: [],
    related: [],
    links: [],
    sessions: [],
    ...patch,
  },
});

test("work trails unite explicit scope-ticket chains without merging tickets that merely share a PR", () => {
  const entities = [
    entity("scope", "scoping", ["scope", "ticket-a"]),
    entity("ticket-a", "issue", ["ticket-a", "scope"]),
    entity("ticket-b", "issue", ["ticket-b"]),
    entity("pr", "pr", ["ticket-a", "ticket-b"]),
    entity("session", "session", ["ticket-a"]),
  ];
  const events: ActivityEvent[] = entities.map((value) => ({
    id: `event:${value.id}`,
    entityId: value.id,
    action: "Last updated",
    occurredAt: null,
    observedAt: "2026-10-06T12:00:00.000Z",
    timeBasis: "unknown",
  }));
  const trails = activityTrails(events, entities);
  assert.equal(trails.length, 2);
  assert.deepEqual(
    trails.find((trail) => trail.root.id === "scope")!.entities.map((value) => value.id),
    ["scope", "ticket-a", "pr", "session"],
  );
  assert.deepEqual(
    trails.find((trail) => trail.root.id === "ticket-b")!.entities.map((value) => value.id),
    ["ticket-b"],
  );
  assert.equal(trails.flatMap((trail) => trail.events).filter((event) => event.entityId === "pr").length, 1);
  assert.deepEqual(
    filterActivity(
      events,
      entities,
      { query: "", sources: [], days: 7, needs: false, work: "scope" },
      Date.parse("2026-10-06T12:00:00.000Z"),
    )
      .map((event) => event.entityId)
      .sort(),
    ["pr", "scope", "session", "ticket-a"],
  );
});

test("a new check failure changes a local handled receipt; avatar-only updates do not", () => {
  const badge = {
    text: "Reply from Alex",
    tone: "amber" as const,
    people: [{ name: "Alex", avatar: "https://example.com/old.png" }],
  };
  const before = entity("pr", "pr", ["pr"], {
    prState: "OPEN",
    checks: "FAILURE",
    checksSummary: { passed: 2, failed: 1, pending: 0, skipped: 0 },
    badges: [badge],
  });
  assert.notEqual(
    activityAttentionSignature(before),
    activityAttentionSignature({
      ...before,
      card: { ...before.card, checksSummary: { passed: 1, failed: 2, pending: 0, skipped: 0 } },
    }),
  );
  assert.equal(
    activityAttentionSignature(before),
    activityAttentionSignature({
      ...before,
      card: {
        ...before.card,
        badges: [{ ...badge, people: [{ name: "Alex", avatar: "https://example.com/new.png" }] }],
      },
    }),
  );
});

test("Today and multi-day selections use calendar boundaries, including a DST transition", () => {
  for (const now of [new Date(2026, 9, 6, 12), new Date(2026, 9, 25, 12)]) {
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    yesterday.setHours(23, 30, 0, 0);
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const events: ActivityEvent[] = [yesterday, today].map((date, index) => ({
      id: String(index),
      entityId: "work",
      action: "Assigned",
      occurredAt: date.toISOString(),
      observedAt: date.toISOString(),
      timeBasis: "source",
    }));
    const entities = [entity("work", "issue", ["work"])];
    const filters = { query: "", sources: [], days: 1, needs: false };
    assert.deepEqual(
      filterActivity(events, entities, filters, now.getTime()).map((event) => event.id),
      ["1"],
    );
    assert.equal(filterActivity(events, entities, { ...filters, days: 3 }, now.getTime()).length, 2);
  }
});

test("PR notifications and Slack replies follow known work links without joining independent tickets", () => {
  const parent = "https://example.slack.com/archives/C123/p1770000000000001";
  const pr = { kind: "pr" as const, title: "Shared PR", url: "https://github.com/example/core/pull/42" };
  const a = entity("DEMO-1", "issue", [], {
    url: "https://linear.app/example/issue/DEMO-1/a",
    rows: [
      pr,
      { kind: "slack", title: "Discussion", url: parent },
      {
        kind: "slack",
        title: "Suggested thread",
        url: "https://example.slack.com/archives/D123/p1770000000000001",
        linkTicketId: "DEMO-1",
      },
    ],
  }).card;
  const b = entity("DEMO-2", "issue", [], { url: "https://linear.app/example/issue/DEMO-2/b", rows: [pr] }).card;
  const notice = entity("notice", "notification", [], { feedSource: "github", url: pr.url }).card;
  const reply = entity("reply", "notification", [], {
    feedSource: "slack",
    url: `${parent.replace("000001", "000002")}?thread_ts=1770000000.000001&cid=C123`,
  }).card;
  const unrelated = entity("dm", "notification", [], {
    feedSource: "slack",
    url: "https://example.slack.com/archives/D123/p1770000000000001",
  }).card;
  const entities = activityEntities([
    {
      version: 1,
      section: "issues",
      generatedAt: "2026-10-06T12:00:00Z",
      updatedAt: null,
      stale: false,
      groups: [{ id: "work", title: "Work", collapsed: false, cards: [a, b, notice, reply, unrelated] }],
    },
  ]);
  const events: ActivityEvent[] = entities.map((e) => ({
    id: `event:${e.id}`,
    entityId: e.id,
    action: "Last updated",
    occurredAt: null,
    observedAt: "2026-10-06T12:00:00Z",
    timeBasis: "unknown",
  }));
  const trails = activityTrails(events, entities);
  const first = trails.find((t) => t.root.card.id === "DEMO-1")!;
  assert.ok(first.entities.some((e) => e.card.id === "notice"));
  assert.ok(first.entities.some((e) => e.card.id === "reply"));
  assert.deepEqual(
    trails.find((t) => t.root.card.id === "DEMO-2")!.entities.map((e) => e.card.id),
    ["DEMO-2"],
  );
  assert.equal(trails.find((t) => t.root.card.id === "dm")?.events.length, 1, "an unrelated DM must stay unlinked");
  for (const work of ["DEMO-1", "DEMO-2"]) {
    const matching = filterActivity(
      events,
      entities,
      { query: "", sources: [], days: 7, needs: false, work },
      Date.parse("2026-10-06T12:00:00Z"),
    );
    assert.ok(matching.some((e) => e.entityId === "notification:github:notice"));
    assert.equal(
      matching.some((e) => e.entityId === "notification:slack:reply"),
      work === "DEMO-1",
    );
  }
});
