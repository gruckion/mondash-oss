import assert from "node:assert/strict";
import test from "node:test";
import { Exit, Schema } from "effect";
import { SectionResponse } from "./contract.ts";

const section = (badge: { text: string; tone: string }, feedSource: string) => ({
  version: 1,
  section: "inbox",
  generatedAt: "2026-09-25T10:00:00.000Z",
  updatedAt: null,
  stale: false,
  groups: [
    {
      id: "direct",
      title: "Direct",
      collapsed: false,
      cards: [
        {
          id: "card",
          title: "Card",
          subtitle: "",
          status: "Todo",
          kind: "notification",
          attention: [],
          labels: [],
          links: [],
          sessions: [],
          related: [],
          badges: [badge],
          feedSource,
        },
      ],
    },
  ],
});

test("a display value newer than the phone degrades instead of failing the section", () => {
  const decoded = Schema.decodeUnknownSync(SectionResponse)(section({ text: "new", tone: "magenta" }, "jira"));
  const [card] = decoded.groups[0].cards;
  assert.equal(card.badges?.[0].tone, "neutral");
  assert.equal("feedSource" in card, false);
});

test("the Mac still cannot encode a display value the contract does not know", () => {
  const encode = Schema.encodeUnknownExit(SectionResponse);
  assert.ok(Exit.isSuccess(encode(section({ text: "ok", tone: "green" }, "slack"))));
  assert.ok(Exit.isFailure(encode(section({ text: "new", tone: "magenta" }, "slack"))));
  assert.ok(Exit.isFailure(encode(section({ text: "ok", tone: "green" }, "jira"))));
});
