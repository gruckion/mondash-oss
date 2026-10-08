import assert from "node:assert/strict";
import { test } from "node:test";
import { slackMessagePreview } from "./slack-message";

const calendarMessage = {
  text: "",
  attachments: [
    {
      fallback: "15 minutes until this event: Daily Check-in",
      pretext: ":loudspeaker: _15 minutes until this event:_",
      title:
        "<!date^1790865000^{time}|3:30 PM> - <!date^1790868600^{time}|4:30 PM> <https://www.google.com/calendar/event?eid=example&amp;ctz=UTC|Daily Check-in>",
      text: "*Guests:* person@example.com\n*Going?*",
      callback_id: "rsvp_event_reminder:15",
      actions: [{ type: "button", text: "Yes", value: "RSVP_ACCEPTED" }],
    },
    {
      fallback: "[no preview available]",
      actions: [{ type: "button", text: "Join Google Meet Meeting", url: "https://meet.google.com/abc-defg-hij" }],
    },
  ],
};

test("Calendar legacy attachments become an event title, exact times and Meet action", () => {
  const preview = slackMessagePreview(calendarMessage);
  assert.equal(preview.title, "Daily Check-in");
  assert.equal(preview.reason, "Event reminder");
  assert.equal(preview.snippet, "3:30 PM – 4:30 PM");
  assert.deepEqual(preview.calendarEvent, { startsAt: "2026-10-01T14:30:00.000Z", endsAt: "2026-10-01T15:30:00.000Z" });
  assert.deepEqual(preview.links, [{ title: "Join Google Meet", url: "https://meet.google.com/abc-defg-hij" }]);
  assert.ok(!preview.snippet.includes("15 minutes"));
});

test("Block Kit sections, fields and rich-text emoji supply meaningful previews", () => {
  const preview = slackMessagePreview({
    text: "Fallback",
    blocks: [
      { type: "header", text: { type: "plain_text", text: "Deploy finished" } },
      {
        type: "section",
        fields: [{ type: "mrkdwn", text: "*Status:* Success" }],
        accessory: {
          type: "button",
          text: { type: "plain_text", text: "Open deployment" },
          url: "https://example.com/deploy",
        },
      },
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [
              { type: "text", text: "Good work " },
              { type: "emoji", name: "+1" },
            ],
          },
        ],
      },
    ],
  });
  assert.equal(preview.snippet, "Deploy finished\nStatus: Success\nGood work 👍");
  assert.deepEqual(preview.links, [{ title: "Open deployment", url: "https://example.com/deploy" }]);
});

test("normal text survives; malformed blocks, unsafe actions and callbacks are ignored", () => {
  assert.equal(slackMessagePreview({ text: ":+1::+1:" }).snippet, "👍👍");
  const preview = slackMessagePreview({
    text: "Fallback",
    blocks: [
      null,
      { type: "section", text: 12 },
      {
        type: "actions",
        elements: [
          { type: "button", text: { text: "Unsafe" }, url: "javascript:alert(1)" },
          { type: "button", text: { text: "RSVP" }, value: "yes" },
        ],
      },
    ],
  });
  assert.equal(preview.snippet, "Fallback");
  assert.deepEqual(preview.links, []);
});

test("ordinary legacy attachment titles and fallback text are readable", () => {
  const preview = slackMessagePreview({
    attachments: [{ title: "*Build passed*", text: "Tests :tada:" }, { fallback: "More details" }],
  });
  assert.equal(preview.title, "Build passed");
  assert.equal(preview.snippet, "Build passed\nTests 🎉\nMore details");
});
