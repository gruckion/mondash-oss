import assert from "node:assert/strict";
import { test } from "node:test";
import { pullRequestIdentity } from "./session-prs";

test("GitHub PR links share identity across anchors while lookalike hosts and non-PR links stay ordinary links", () => {
  assert.deepEqual(pullRequestIdentity("https://github.com/Example/App/pull/42/files#diff-1"), {
    repo: "Example/App",
    number: 42,
    url: "https://github.com/Example/App/pull/42",
    key: "example/app#42",
  });
  for (const href of [
    "https://github.com.evil.test/Example/App/pull/42",
    "https://github.com/Example/App/issues/42",
    "https://github.com/Example/App/pull/42x",
    "https://github.com/Example/App/pull/0",
    "https://github.com/Example/App/pull/9999999999999999999",
    "javascript:alert(1)",
  ])
    assert.equal(pullRequestIdentity(href), undefined);
});
