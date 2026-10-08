// Run: node --test src/lib/notion-comments.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { notionReply, parseDiscussions } from "./notion-comments.ts";

const comment = (user: string, at: string) =>
  `<comment id="c" url="https://notion/${user}/${at}" user-url="user://${user}/${user}@example.com" datetime="${at}">text</comment>`;
const discussion = (resolved: boolean, ...comments: string[]) =>
  `<discussion id="d" comment-count="${comments.length}" resolved="${resolved}" type="comment">\n${comments.join("\n")}\n</discussion>`;
const xml = (...discussions: string[]) => `<discussions>\n${discussions.join("\n")}\n</discussions>`;

test("a reply to your comment needs you until you answer or it is resolved", () => {
  const replied = parseDiscussions(xml(discussion(false, comment("me", "2026-09-01"), comment("alice", "2026-09-02"))));
  assert.deepEqual(notionReply(replied, "me", false), {
    from: ["alice@example.com"],
    count: 1,
    at: new Date("2026-09-02"),
    url: "https://notion/alice/2026-09-02",
  });
  const answered = parseDiscussions(
    xml(discussion(false, comment("me", "2026-09-01"), comment("alice", "2026-09-02"), comment("me", "2026-09-03"))),
  );
  assert.equal(notionReply(answered, "me", false), null);
  const resolved = parseDiscussions(xml(discussion(true, comment("me", "2026-09-01"), comment("alice", "2026-09-02"))));
  assert.equal(notionReply(resolved, "me", false), null);
});

test("other people's threads need you only on your own doc", () => {
  const others = parseDiscussions(xml(discussion(false, comment("bob", "2026-09-01"), comment("alice", "2026-09-02"))));
  assert.equal(notionReply(others, "me", false), null);
  assert.deepEqual(notionReply(others, "me", true)?.from, ["alice@example.com"]);
});

test("every waiting thread counts, newest person first; your own last word is not a reply", () => {
  const two = parseDiscussions(
    xml(
      discussion(false, comment("bob", "2026-09-05")),
      discussion(false, comment("alice", "2026-09-02")),
      discussion(false, comment("me", "2026-09-09")),
    ),
  );
  const r = notionReply(two, "me", true);
  assert.deepEqual(r?.from, ["bob@example.com", "alice@example.com"]);
  assert.equal(r?.count, 2);
});
