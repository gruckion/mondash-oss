// Run: node --test src/lib/slack.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSearch, parseThread, plain, shortName, ticketIds } from "./slack.ts";

const sample = `# Search Results for: is:saved

## Messages (1 results)
### Result 1 of 1
Channel: #eng (ID: CDEMO45FBCE)
From: Avery Brooks <avery@example.com> (ID: UDEMO000006)
Time: 2026-09-18 17:07:17 BST
Message_ts: 1789747637.478879
Permalink: [link](https://x.slack.com/archives/CDEMO45FBCE/p1?thread_ts=1789747637.000001&cid=CDEMO45FBCE)
Text:
<@UDEMO000001|Taylor Reed> see <https://linear.app/example/issue/DEMO-4188/x|Fix it> &amp; DEMO-4188

---
`;

test("parseSearch reads one result", () => {
  const [item] = parseSearch(sample);
  assert.equal(item.channel, "#eng");
  assert.equal(item.channelId, "CDEMO45FBCE");
  assert.equal(item.from, "Avery Brooks");
  assert.equal(item.userId, "UDEMO000006");
  assert.equal(item.threadTs, "1789747637.000001");
  assert.equal(item.postedAt.toISOString(), "2026-09-18T16:07:17.478Z");
  assert.match(item.text, /^<@UDEMO000001\|Taylor Reed> see/);
});

test("plain and ticketIds", () => {
  const [item] = parseSearch(sample);
  assert.equal(plain(item.text), "@Taylor Reed see Fix it & DEMO-4188");
  assert.deepEqual(ticketIds(item.text), ["DEMO-4188"]);
});

test("plain renders Slack emoji, adjacent shortcodes, aliases and skin tones", () => {
  assert.equal(plain(":+1::+1::+1:"), "👍👍👍");
  assert.equal(plain(":thumbsup: :smile: :tada: :heart:"), "👍 😄 🎉 ❤️");
  assert.equal(plain(":+1::skin-tone-2: :wave::skin-tone-4: :thumbsup::skin-tone-6:"), "👍🏻 👋🏽 👍🏿");
  assert.equal(plain("Already 👍 :mondash_custom: :constructor:"), "Already 👍 :mondash_custom: :constructor:");
  assert.equal(plain("<https://example.com|Party :tada:> &amp; :+1:"), "Party 🎉 & 👍");
});

test("shortName keeps the first name and the last initial", () => {
  assert.equal(shortName("Avery Brooks"), "Avery B");
  assert.equal(shortName("Renée de Frost"), "Renée F");
  assert.equal(shortName("Morgan"), "Morgan");
});

test("parseThread reads parent, replies, participants and last reply time", () => {
  const thread = `=== THREAD PARENT MESSAGE ===
From: Avery <avery@example.com> (UDEMO000006)
Time: 2026-09-17 04:07:49 BST
Message TS: 1789614469.756759
I noticed that renewals get overdue notices.

=== THREAD REPLIES (2 total) ===

--- Reply 1 of 2 ---
From: Taylor Reed <taylor@example.com> (UDEMO000001)
Time: 2026-09-17 09:47:51 BST
Message TS: 1789634871.603469
Yikes, can take a look.

--- Reply 2 of 2 ---
From: Avery <avery@example.com> (UDEMO000006)
Time: 2026-09-20 23:55:08 BST
Message TS: 1789944908.670929
thanks`;
  const t = parseThread(thread);
  assert.equal(t.from, "Avery");
  assert.equal(t.text, "I noticed that renewals get overdue notices.");
  assert.equal(t.replyCount, 2);
  assert.deepEqual(t.participants, ["Avery", "Taylor Reed"]);
  assert.equal(t.lastAt?.toISOString(), "2026-09-20T22:55:08.670Z");
});
