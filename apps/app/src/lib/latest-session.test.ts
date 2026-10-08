import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session } from "@mondash/shared/contract";
import { latestSession } from "./latest-session";

const session = (id: string, updatedAt: string, jev: number, tool: Session["tool"] = "claude"): Session => ({
  id,
  title: id,
  tool,
  updatedAt,
  jev,
  canOpenOnMac: true,
  canOpenInClaude: true,
  canOpenInChatGPT: true,
});
const bestMatch = session("best-match", "2026-10-05T15:00:00Z", 0.96);
const newestClaude = session("newest-claude", "2026-10-05T17:00:00Z", 0.86);
const newestCodex = session("newest-codex", "2026-10-05T18:00:00Z", 0.7, "codex");

test("quick-open follows the newest associated session across providers, independent of Jev ranking", () => {
  assert.equal(latestSession([]), undefined);
  assert.equal(latestSession([bestMatch, newestClaude])?.id, "newest-claude");
  assert.equal(latestSession([bestMatch, newestClaude, newestCodex])?.id, "newest-codex");
  assert.equal(latestSession([newestCodex, bestMatch, newestClaude])?.id, "newest-codex");
  assert.equal(
    latestSession([{ ...newestCodex, archived: true }, bestMatch])?.id,
    "newest-codex",
    "an archived session still has the same Open action",
  );
  assert.equal(
    latestSession([
      { ...newestClaude, jev: 0.6 },
      { ...bestMatch, updatedAt: newestClaude.updatedAt },
    ])?.id,
    "best-match",
    "equally recent sessions use the stronger association",
  );
});
