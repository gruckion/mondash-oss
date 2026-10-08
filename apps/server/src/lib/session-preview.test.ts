import assert from "node:assert/strict";
import { test } from "node:test";
import { PREVIEW_LIMIT, previewText, sessionPreview } from "./session-preview.ts";

const at = "2026-09-24T20:00:00Z";
const later = "2026-09-24T20:01:00Z";
const claude = (content: string, timestamp = at) => ({ type: "system", subtype: "away_summary", content, timestamp });
const codex = (text: string, phase: string | null = "final_answer", timestamp = at) => ({
  type: "response_item",
  timestamp,
  payload: { type: "message", role: "assistant", phase: phase ?? undefined, content: [{ type: "output_text", text }] },
});

test("Claude preview uses the latest real recap, removing its settings hint", () => {
  const result = sessionPreview("claude", [
    claude("Old recap"),
    claude("**New recap.** Next, review the fix. (disable recaps in /config)", later),
    { type: "user", message: { content: "Do something else" } },
    { type: "assistant", message: { content: [{ type: "text", text: "An answer, not a recap" }] } },
    { type: "system", subtype: "stop_hook_summary", content: "Hook output", timestamp: later },
    { ...claude("Subagent recap", later), isSidechain: true },
  ]);
  assert.deepEqual(result, {
    preview: "New recap. Next, review the fix.",
    previewKind: "recap",
    previewAt: Date.parse(later),
  });
});

test("Codex preview selects the latest completed assistant response, excluding commentary and analysis", () => {
  const result = sessionPreview("codex", [
    codex("Old answer"),
    codex("**Finished.** All checks pass.", "final_answer", later),
    codex("Working on it", "commentary", "2026-09-24T20:02:00Z"),
    {
      ...codex("private thought", null, later),
      payload: {
        ...codex("").payload,
        channel: "analysis",
        content: [{ type: "output_text", text: "private thought" }],
      },
    },
    { ...codex("tool output", "final_answer", later), type: "event_msg" },
    { ...codex("user prompt", "final_answer", later), payload: { ...codex("").payload, role: "user" } },
  ]);
  assert.equal(result?.preview, "Finished. All checks pass.");
  assert.equal(result?.previewKind, "response");
});

test("legacy Codex answers without a phase are supported; unrelated records never become previews", () => {
  const legacy = codex("Older transcript format", null);
  assert.equal(sessionPreview("codex", [legacy])?.preview, "Older transcript format");
  assert.equal(sessionPreview("claude", [{ type: "ai-title", aiTitle: "Title" }, null, {}]), undefined);
  assert.equal(
    sessionPreview("codex", [null, { type: "response_item", payload: { type: "reasoning", text: "hidden" } }]),
    undefined,
  );
});

test("preview text is compact, bounded and does not expose local absolute paths or Markdown links", () => {
  const result = previewText(
    "## Fixed\n- Read [report](/Users/person/private/report.md) and `/tmp/build.log`.\n**Tests pass.**",
  );
  assert.equal(result, "Fixed Read report and [local file]. Tests pass.");
  const long = previewText("a".repeat(PREVIEW_LIMIT + 100));
  assert.equal(long.length, PREVIEW_LIMIT);
  assert.ok(long.endsWith("…"));
});

test("a Claude session with no recap shows Claude's last reply", async () => {
  const { sessionPreview } = await import("./session-preview.ts");
  const said = (text: string, at: string, extra = {}) => ({
    type: "assistant",
    timestamp: at,
    message: { content: [{ type: "text", text }, { type: "tool_use" }] },
    ...extra,
  });
  assert.deepEqual(
    sessionPreview("claude", [
      said("First answer.", "2026-09-25T10:00:00Z"),
      said("Agent chatter.", "2026-09-25T10:02:00Z", { isSidechain: true }),
      said("Final answer.", "2026-09-25T10:01:00Z"),
    ]),
    { preview: "Final answer.", previewKind: "response", previewAt: Date.parse("2026-09-25T10:01:00Z") },
  );
  const withRecap = sessionPreview("claude", [
    said("Reply.", "2026-09-25T10:03:00Z"),
    { type: "system", subtype: "away_summary", content: "The recap.", timestamp: "2026-09-25T10:00:00Z" },
  ]);
  assert.equal(withRecap?.previewKind, "recap");
});
