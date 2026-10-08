import assert from "node:assert/strict";
import { test } from "node:test";
import { slackThreadUrl } from "./slack-thread-url.ts";

test("a parent-message permalink explicitly opens its thread", () => {
  assert.equal(
    slackThreadUrl("https://examplehq.slack.com/archives/CDEMO45FBCE/p1788983804110439"),
    "https://examplehq.slack.com/archives/CDEMO45FBCE/p1788983804110439?thread_ts=1788983804.110439&cid=CDEMO45FBCE",
  );
});
test("a reply preserves its original parent, exact timestamp and other parameters", () => {
  const url =
    "https://examplehq.slack.com/archives/CDEMO45FBCE/p1789750000000001?thread_ts=1789747637.000001&cid=CDEMO45FBCE&foo=bar";
  assert.equal(slackThreadUrl(url), url);
  assert.equal(slackThreadUrl(slackThreadUrl(url)), url);
});
test("channel links, other providers and lookalike hosts are unchanged", () => {
  for (const url of [
    "https://examplehq.slack.com/archives/CDEMO45FBCE",
    "https://github.com/ExampleOrg/core/pull/1",
    "https://examplehq.slack.com.evil.test/archives/C123/p1788983804110439",
    "invalid",
  ])
    assert.equal(slackThreadUrl(url), url);
});
