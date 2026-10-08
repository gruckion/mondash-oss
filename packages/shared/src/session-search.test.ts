import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { SessionSearchInput, searchCandidates, rankSessionGroups } from "./session-search";
import { applyView, viewOptionsFor } from "./view-options";
import type { Group } from "./contract";

const groups: readonly Group[] = [false, true].map((archived, index) => ({
  id: archived ? "archived" : "sessions",
  title: "Sessions",
  collapsed: false,
  cards: [
    {
      id: String(index),
      title: archived ? "Small deposits not confirmed" : "Payment retries",
      subtitle: "Claude Code",
      status: "Recent",
      kind: "session" as const,
      attention: [],
      labels: [],
      links: [],
      related: [],
      updatedAt: index ? "2026-10-01T10:00:00Z" : "2026-10-03T10:00:00Z",
      sessions: [
        {
          id: String(index),
          tool: "claude" as const,
          title: "session",
          updatedAt: "2026-10-03T10:00:00Z",
          canOpenOnMac: false,
          archived,
          preview: "The bank account verification failed",
        },
      ],
    },
  ],
}));

test("search sends only the filtered display fields and respects a hidden preview", () => {
  const filtered = applyView("sessions", groups, viewOptionsFor("sessions"));
  assert.deepEqual(searchCandidates(filtered, false), [
    { id: "0", tool: "claude", title: "Payment retries", subtitle: "Claude Code", preview: "" },
  ]);
  assert.equal(searchCandidates(filtered, true)[0].preview, "The bank account verification failed");
});

test("semantic rank crosses archive groups, keeps zero-score candidates and preserves the saved list", () => {
  const before = JSON.stringify(groups);
  const ranked = rankSessionGroups(
    groups,
    "Stripe microdeposits",
    [
      { id: "0", tool: "claude", score: 0, confidence: 1 },
      { id: "1", tool: "claude", score: 0.9, confidence: 0.7 },
    ],
    true,
  );
  assert.deepEqual(
    ranked[0].cards.map((card) => card.id),
    ["1", "0"],
  );
  assert.equal(ranked[0].cards[0].sessions[0].jev, 0.9);
  assert.equal(JSON.stringify(groups), before);
  assert.equal(rankSessionGroups(groups, "", [], true), groups);
});

test("search accepts more than 500 visible sessions and matches displayed subtitles in fallback", () => {
  const candidate = {
    id: "dde0fda5-cf7e-53b3-9ece-c5021f32174c",
    tool: "claude",
    title: "Payments",
    subtitle: "Claude Code",
    preview: "",
  };
  assert.equal(
    Schema.decodeUnknownSync(SessionSearchInput)({
      query: "Claude",
      candidates: Array.from({ length: 501 }, () => candidate),
    }).candidates.length,
    501,
  );
  const mixed = [
    {
      ...groups[0],
      cards: [
        { ...groups[0].cards[0], subtitle: "Codex", updatedAt: "2026-10-01T10:00:00Z" },
        { ...groups[1].cards[0], subtitle: "Claude Code", updatedAt: "2026-10-03T10:00:00Z" },
      ],
    },
  ];
  assert.equal(rankSessionGroups(mixed, "Codex", [], false)[0].cards[0].subtitle, "Codex");
});
