import assert from "node:assert/strict";
import { test } from "node:test";
import { docMentions } from "./doc-mentions.ts";

test("mentions come from the page's words, not its properties or markup", () => {
  const page =
    `<page><properties>{"Assign":["<mention-user url=\\"user://1\\"></mention-user>"],"Ref":"DEMO-1"}</properties>` +
    `<iconMetadata>null</iconMetadata><content> Needs more scoping but context here: [https://linear.app/example/issue/DEMO-3972/x](https://linear.app/example/issue/DEMO-3972/x) <empty-block/> Other feedback.</content></page>`;
  const mentions = docMentions(page, 200);
  assert.deepEqual([...mentions.keys()], ["DEMO-3972"], "a ticket only in the properties is not a mention");
  const text = mentions.get("DEMO-3972") ?? "";
  assert.match(text, /^Needs more scoping but context here:/);
  assert.doesNotMatch(text, /mention-user|properties|iconMetadata|empty-block/);
});

test("a page without properties is read whole", () => {
  assert.deepEqual([...docMentions("See DEMO-12 and demo-9").keys()], ["DEMO-12"]);
});
