// Run: node --test src/lib/app-urls.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { linearAppUrl, notionAppUrl, slackAppUrl } from "./app-urls.ts";

test("Notion links carry the title, so the app finds a tab already showing that page", () => {
  assert.equal(
    notionAppUrl("https://app.notion.com/p/10cbd16426aa5a5aab18945e5fec57ed", "Differentiate renewals from invoices"),
    "notion://www.notion.so/Differentiate-renewals-from-invoices-10cbd16426aa5a5aab18945e5fec57ed?deepLinkOpenNewTab=true",
  );
  assert.equal(
    notionAppUrl("https://app.notion.com/p/e0f15ad5d7b059ea8b9fa1710fbd7501", "Late Fees & Financial Hold"),
    "notion://www.notion.so/Late-Fees-Financial-Hold-e0f15ad5d7b059ea8b9fa1710fbd7501?deepLinkOpenNewTab=true",
    "punctuation is dropped, as Notion does",
  );
});

test("Notion links open the same page and comment in the app", () => {
  assert.equal(
    notionAppUrl(
      "https://app.notion.com/p/e0f15ad5d7b059ea8b9fa1710fbd7501?d=1d34b2be69f3529e915ad14a0222214e&pvs=42#72175dfca61d53d3b5c7394fcbc96e66",
    ),
    "notion://www.notion.so/e0f15ad5d7b059ea8b9fa1710fbd7501?d=1d34b2be69f3529e915ad14a0222214e&deepLinkOpenNewTab=true#72175dfca61d53d3b5c7394fcbc96e66",
  );
  assert.equal(
    notionAppUrl("https://www.notion.so/Stripe-Application-Fee-e0f15ad5d7b059ea8b9fa1710fbd7501"),
    "notion://www.notion.so/Stripe-Application-Fee-e0f15ad5d7b059ea8b9fa1710fbd7501?deepLinkOpenNewTab=true",
    "the app reuses the tab already showing the page, or opens a new one",
  );
});

test("Slack links open the message, and a reply opens in its thread", () => {
  assert.equal(
    slackAppUrl("https://examplehq.slack.com/archives/CDEMO45FBCE/p1789747637478879", "TDEMO0019D9"),
    "slack://channel?team=TDEMO0019D9&id=CDEMO45FBCE&message=1789747637.478879",
  );
  assert.equal(
    slackAppUrl(
      "https://examplehq.slack.com/archives/CDEMO45FBCE/p1789750000000000?thread_ts=1789747637.478879&cid=CDEMO45FBCE",
      "T1",
    ),
    "slack://channel?team=T1&id=CDEMO45FBCE&message=1789750000.000000&thread_ts=1789747637.478879",
  );
});

test("Linear links keep their path", () => {
  assert.equal(
    linearAppUrl("https://linear.app/example/issue/DEMO-4188/when-a-service-type"),
    "linear://example/issue/DEMO-4188/when-a-service-type",
  );
  assert.equal(linearAppUrl("https://example.com/x"), "https://example.com/x");
  assert.equal(
    linearAppUrl("https://linear.app/example/issue/DEMO-4188?comment=abc#reply"),
    "linear://example/issue/DEMO-4188?comment=abc#reply",
  );
});

test("Notion accepts dashed and uppercase page IDs, retaining the title, view and comment", () => {
  assert.equal(
    notionAppUrl("https://www.notion.so/Plan-E0F15AD5-D7B0-59EA-8B9F-A1710FBD7501?v=view&d=comment#block"),
    "notion://www.notion.so/Plan-e0f15ad5d7b059ea8b9fa1710fbd7501?v=view&d=comment&deepLinkOpenNewTab=true#block",
  );
  assert.equal(notionAppUrl("https://www.notion.com/help"), "https://www.notion.com/help");
});

test("Slack channel links work and malformed permalinks stay on the web", () => {
  assert.equal(slackAppUrl("https://examplehq.slack.com/archives/D123", "T1"), "slack://channel?team=T1&id=D123");
  for (const url of [
    "https://examplehq.slack.com/archives/C1/p1789747637478879garbage",
    "https://examplehq.slack.com/archives/C1/p1789747637478879?thread_ts=bad",
  ])
    assert.equal(slackAppUrl(url, "T1"), url);
});
