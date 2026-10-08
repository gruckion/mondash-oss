import assert from "node:assert/strict";
import { test } from "node:test";
import { inboxKind, messageEvent, permalink } from "./slack-events";

const envelope = (event: Record<string, unknown>) =>
  JSON.stringify({ envelope_id: "e1", type: "events_api", payload: { type: "event_callback", event } });
const message = (fields: Record<string, unknown>) =>
  messageEvent(envelope({ type: "message", channel: "C1", user: "U2", text: "hi", ts: "100.000200", ...fields }));

test("new messages are read from the envelope; edits, bot posts and other events are not", () => {
  assert.equal(message({})?.channel, "C1");
  assert.equal(message({ subtype: "file_share" })?.ts, "100.000200");
  assert.equal(message({ subtype: "message_changed" }), undefined);
  assert.equal(message({ user: undefined, subtype: "bot_message" }), undefined);
  assert.equal(messageEvent(envelope({ type: "reaction_added", user: "U2" })), undefined);
  assert.equal(messageEvent('{"type":"hello"}'), undefined);
});

test("a message is filed as a DM, a mention or a reply in your thread, like the searches would", () => {
  const me = "UME";
  const mine = new Set(["90.000000"]);
  const kind = (fields: Record<string, unknown>) => {
    const event = message(fields);
    return event ? inboxKind(event, me, mine) : "not a message";
  };
  assert.equal(kind({ channel_type: "im" }), "dm");
  assert.equal(kind({ channel_type: "mpim" }), "dm");
  assert.equal(kind({ channel_type: "channel", text: "ping <@UME>" }), "mention");
  assert.equal(kind({ channel_type: "channel", thread_ts: "90.000000" }), "thread_reply");
  assert.equal(kind({ channel_type: "channel", thread_ts: "80.000000" }), undefined);
  assert.equal(kind({ channel_type: "channel" }), undefined);
  assert.equal(kind({ channel_type: "im", user: "UME" }), undefined);
});

test("a reply links into its thread", () => {
  const event = message({ thread_ts: "90.000000" });
  assert.ok(event);
  assert.equal(
    permalink("https://x.slack.com/", event),
    "https://x.slack.com/archives/C1/p100000200?thread_ts=90.000000&cid=C1",
  );
});

test("socket messages retain rich blocks and attachments when text is empty", () => {
  const attachments = [{ title: "Meeting", actions: [{ type: "button", text: "Join", url: "https://example.com" }] }];
  const blocks = [{ type: "section", text: { type: "mrkdwn", text: "Details" } }];
  const event = message({ text: "", attachments, blocks });
  assert.deepEqual(event?.attachments, attachments);
  assert.deepEqual(event?.blocks, blocks);
});
