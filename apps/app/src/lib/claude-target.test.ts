import assert from "node:assert/strict";
import { test } from "node:test";
import { isMacBrowser, readClaudeTarget } from "./claude-target";

test("Mac settings never redirect iPhone or iPad desktop browsing away from the mobile app", () => {
  assert.equal(isMacBrowser("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0), true);
  assert.equal(isMacBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", 5), false);
  assert.equal(isMacBrowser("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5), false);
  assert.equal(isMacBrowser("Mozilla/5.0 (Windows NT 10.0)", 0), false);
});

test("a saved Mac preference survives reload and invalid preferences use Claude Desktop", () => {
  assert.equal(readClaudeTarget("terminal"), "terminal");
  assert.equal(readClaudeTarget("claude-desktop"), "claude-desktop");
  assert.equal(readClaudeTarget(null), "claude-desktop");
  assert.equal(readClaudeTarget("arbitrary-command"), "claude-desktop");
});
