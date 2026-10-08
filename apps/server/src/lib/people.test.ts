// Run: node --test src/lib/people.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { displayName, person } from "./people.ts";

test("GitHub logins, emails and Slack IDs find the same person", () => {
  assert.equal(person("morgan-demo")?.email, "morgan@example.com");
  assert.equal(person("MORGAN@example.com")?.github, "morgan-demo");
  assert.equal(person("UDEMO000002")?.name, "Morgan Park");
  assert.equal(person("Renée Frost")?.github, "renee-demo", "Linear names the assigner in full");
});

test("names show as first name and last initial; unknown keys as they are", () => {
  assert.equal(displayName("renee-demo"), "Renée F");
  assert.equal(displayName("someone@example.com"), "someone");
  assert.equal(displayName("octocat"), "octocat");
});
