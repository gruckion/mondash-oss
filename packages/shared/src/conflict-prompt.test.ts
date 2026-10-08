// Run: bun test packages/shared/src/conflict-prompt.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { codexUrl, conflictPrompt, withReviewers } from "./conflict-prompt.ts";

const core = {
  url: "https://github.com/ExampleOrg/core/pull/2161",
  repo: "ExampleOrg/core",
  branch: "demo-4148-overdue",
};
const web = { url: "https://github.com/ExampleOrg/web/pull/1729", repo: "ExampleOrg/web", branch: "demo-4148-overdue" };

test("the prompt names the PR, its related PRs and the standing rules", () => {
  const prompt = conflictPrompt(core, [core, web], "DEMO-4148", "/work/example");
  assert.match(prompt, /core\/pull\/2161 \(branch `demo-4148-overdue`\) for DEMO-4148/);
  assert.match(prompt, /web\/pull\/1729/);
  assert.doesNotMatch(
    prompt,
    /- https:\/\/github.com\/ExampleOrg\/core\/pull\/2161/,
    "the PR itself is not listed as related",
  );
  assert.match(prompt, /under \/work\/example\//);
  assert.doesNotMatch(prompt, /projects|mobile-app|admin-console/);
  assert.match(prompt, /authenticated GitHub user/);
  assert.match(prompt, /CONFLICTING/);
  assert.match(prompt, /baseRefName/);
  assert.doesNotMatch(prompt, /origin\/main/);
  assert.match(prompt, /Never rebase/);
  assert.match(prompt, /Never hand-edit generated files/);
});

test("only the chosen AI reviewers are asked to review again", () => {
  const both = withReviewers("P", { coderabbit: true, greptile: true });
  assert.match(both, /@coderabbitai review`.*@greptileai review/);
  const one = withReviewers("P", { coderabbit: false, greptile: true });
  assert.doesNotMatch(one, /coderabbitai/);
  assert.doesNotMatch(withReviewers("P", { coderabbit: false, greptile: false }), /review again/);
});

test("the Codex link carries the folder and the prompt", () => {
  const url = new URL(codexUrl("fix it & push", "/Users/me/example"));
  assert.equal(url.protocol, "codex:");
  assert.equal(url.searchParams.get("path"), "/Users/me/example");
  assert.equal(url.searchParams.get("prompt"), "fix it & push");
});
