import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import type { SectionResponse } from "@mondash/shared/contract";
import { parseHave, sectionEvent, sentFrom } from "./section-stream";

const section = (title: string, updatedAt = "2026-09-27T10:00:00.000Z", stale = false): SectionResponse => ({
  version: 1,
  section: "issues",
  generatedAt: "2026-09-27T10:30:00.000Z",
  updatedAt,
  stale,
  groups: [{ id: "g", title, collapsed: false, cards: [] }],
});

test("a section is sent whole when its content changes, and as its times when only they move", () => {
  const sent = sentFrom(null);
  const send = (s: SectionResponse) => Effect.runSync(sectionEvent(sent, "issues", s));
  assert.match(send(section("A")), /^data: \{"version":"[0-9a-f]{16}","section":\{/);
  assert.equal(send(section("A")), "", "nothing moved");
  assert.equal(
    send(section("A", "2026-09-27T10:05:00.000Z", true)),
    `data: {"times":{"section":"issues","updatedAt":"2026-09-27T10:05:00.000Z","stale":true}}\n\n`,
  );
  assert.equal(send(section("A", "2026-09-27T10:05:00.000Z", true)), "");
  assert.match(send(section("B", "2026-09-27T10:05:00.000Z", true)), /"section":\{/);
});

test("a section the app already has is not sent again, but its times are, once", () => {
  const full = Effect.runSync(sectionEvent(sentFrom(null), "issues", section("A")));
  const version = full.match(/"version":"([0-9a-f]{16})"/)?.[1];
  const sent = sentFrom(`issues:${version}`);
  assert.match(Effect.runSync(sectionEvent(sent, "issues", section("A"))), /^data: \{"times":/);
  assert.equal(Effect.runSync(sectionEvent(sent, "issues", section("A"))), "");
});

test("the versions the app already has are read from the query string", () => {
  assert.deepEqual(
    [...parseHave("issues:ab12,reviews:cd34,broken")],
    [
      ["issues", "ab12"],
      ["reviews", "cd34"],
    ],
  );
});
