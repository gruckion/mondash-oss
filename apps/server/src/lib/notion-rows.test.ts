import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import type { Group, Row } from "@mondash/shared/contract";
import { enrichNotionRows, notionPeople, notionRowMetadata } from "./notion-rows.ts";

const people = notionPeople({
  results: [
    { id: "owner", email: "taylor@example.com" },
    { id: "reviewer", email: "morgan@example.com" },
    { id: "other", email: "quinn@example.com" },
  ],
});
const page = (properties: unknown) => ({
  text: `<page><properties>\n${JSON.stringify(properties)}\n</properties><content>Unrelated text</content></page>`,
});

test("Notion metadata preserves assignment and reviewer order and reads actual effort/date properties", () => {
  assert.deepEqual(
    notionRowMetadata(
      page({
        Assign: ['<mention-user url="user://owner"></mention-user>', "user://other"],
        Reviewer: ['<mention-user url="user://reviewer"></mention-user>', "user://owner", "user://other"],
        Effort: "",
        "Effort (Days)": 6.5,
        Created: "2026-09-15T15:18:39.574Z",
        "Last edited time": "2026-09-24T14:40:31.697Z",
      }),
      people,
    ),
    {
      // You are never listed.
      assignees: [{ name: "Quinn O" }],
      reviewers: [{ name: "Morgan P" }, { name: "Quinn O" }],
      effort: "6.5d",
      createdAt: "2026-09-15T15:18:39.574Z",
      updatedAt: "2026-09-24T14:40:31.697Z",
    },
  );
});

test("empty optional metadata stays absent and missing users are not shown as opaque IDs", () => {
  assert.deepEqual(notionRowMetadata(page({ Assign: ["user://unknown"], Effort: "", Created: "bad date" }), people), {
    assignees: [],
    reviewers: [],
    createdAt: undefined,
    updatedAt: undefined,
  });
  assert.equal(
    notionRowMetadata({ ...page({ Effort: "Small" }), page_last_edited_at: "2026-09-24T14:40:31Z" }, people).updatedAt,
    "2026-09-24T14:40:31.000Z",
  );
  assert.equal(notionRowMetadata(page({ Effort: "Small" }), people).effort, "Small");
});

test("Notion page enrichment deduplicates different URL forms and retains links when a page is unavailable", async () => {
  const rows: Row[] = [
    { kind: "notion", title: "Billing", url: "https://www.notion.so/Billing-8b18ef00e5de589f9dc760130e0b18cc" },
    { kind: "notion", title: "Billing", url: "https://app.notion.com/p/8b18ef00-e5de-589f-9dc7-60130e0b18cc" },
    { kind: "notion", title: "Inaccessible", url: "https://app.notion.com/p/e0f15ad5d7b059ea8b9fa1710fbd7501" },
  ];
  const groups: Group[] = [
    {
      id: "issues",
      title: "",
      collapsed: false,
      cards: [
        {
          id: "ticket",
          kind: "issue",
          title: "Ticket",
          subtitle: "",
          status: "",
          attention: [],
          labels: [],
          links: [],
          related: [],
          sessions: [],
          rows,
        },
      ],
    },
  ];
  const calls: string[] = [];
  const enriched = await Effect.runPromise(
    enrichNotionRows(groups, (id) =>
      Effect.tryPromise(async () => {
        calls.push(id);
        if (id === "e0f15ad5d7b059ea8b9fa1710fbd7501") throw new Error("Not found");
        return { effort: "2d", assignees: [{ name: "Taylor R" }] };
      }),
    ),
  );
  assert.deepEqual(calls, ["8b18ef00e5de589f9dc760130e0b18cc", "e0f15ad5d7b059ea8b9fa1710fbd7501"]);
  assert.equal(rows[0].effort, undefined, "readonly input is untouched");
  const updated = enriched[0].cards[0].rows!;
  assert.equal(updated[0].effort, "2d");
  assert.equal(updated[1].effort, "2d");
  assert.equal(rows[2].effort, undefined);
  assert.equal(rows[2].title, "Inaccessible");
});
