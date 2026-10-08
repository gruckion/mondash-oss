import assert from "node:assert/strict";
import { test } from "node:test";
import type { Group } from "@mondash/shared/contract";
import { sessionDateGroups } from "./session-date-groups";

const at = (year: number, month: number, day: number, hour = 12) => new Date(year, month - 1, day, hour);
const group = (dates: readonly Date[], archived = false): Group => ({
  id: archived ? "archived" : "sessions",
  title: "Sessions",
  collapsed: false,
  cards: dates.map((date) => ({
    id: date.toISOString(),
    title: "Session",
    subtitle: "Claude Code",
    status: "Recent",
    kind: "session",
    attention: [],
    labels: [],
    links: [],
    related: [],
    // Deliberately older than the actual session activity.
    updatedAt: at(2025, 1, 1).toISOString(),
    sessions: [
      {
        id: date.toISOString(),
        tool: "claude",
        title: "Session",
        updatedAt: date.toISOString(),
        canOpenOnMac: false,
        archived,
      },
    ],
  })),
});
const labels = (groups: readonly Group[]) => groups.map(({ title }) => title);

test("recent sessions form disjoint calendar groups across archives, newest first, without changing the snapshot", () => {
  const today = at(2026, 10, 22, 15);
  const earlierToday = at(2026, 10, 22, 9);
  const input = [
    group([at(2026, 10, 1), at(2026, 10, 19), earlierToday, at(2026, 8, 30), at(2025, 12, 31)]),
    group([at(2026, 10, 20), at(2026, 10, 21), today, at(2026, 10, 18), at(2026, 9, 30)], true),
  ];
  const before = JSON.stringify(input);
  const result = sessionDateGroups(input, today);
  assert.deepEqual(labels(result), [
    "Today",
    "Yesterday",
    "Tuesday",
    "Monday",
    "Last week",
    "Earlier this month",
    "Last month",
    "August",
    "2025",
  ]);
  assert.deepEqual(
    result[0].cards.map(({ id }) => id),
    [today.toISOString(), earlierToday.toISOString()],
  );
  assert.equal(result.flatMap(({ cards }) => cards).length, 10);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(sessionDateGroups([], today), []);
});

test("Yesterday takes precedence over last week on a Monday, including across the year boundary", () => {
  const input = [group([at(2026, 1, 5), at(2026, 1, 4), at(2025, 12, 29), at(2025, 12, 28), at(2025, 11, 30)])];
  const result = sessionDateGroups(input, at(2026, 1, 5));
  assert.deepEqual(labels(result), ["Today", "Yesterday", "Last week", "Last month", "2025"]);
  assert.equal(result[2].cards[0].id, at(2025, 12, 29).toISOString());
});

test("local midnight determines Today and Yesterday around both daylight saving changes", () => {
  for (const [month, day] of [
    [3, 29],
    [10, 25],
  ]) {
    const input = [group([at(2026, month, day, 0), at(2026, month, day - 1, 23), at(2026, month, day - 2, 23)])];
    assert.deepEqual(labels(sessionDateGroups(input, at(2026, month, day, 23))), ["Today", "Yesterday", "Friday"]);
  }
});
