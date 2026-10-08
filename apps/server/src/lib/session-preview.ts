import { Option, Schema } from "effect";
import { basename } from "node:path";

export type SessionPreview = { preview: string; previewKind: "recap" | "response"; previewAt: number };
export const PREVIEW_LIMIT = 1200;

const LOCAL_PATH = /(?:file:\/\/)?\/(?:Users|home|private|tmp|var|Volumes)\/[^\s`<>)]*/g;
const WINDOWS_PATH = /[A-Za-z]:\\(?:[^\s`<>)]*)/g;
const LOCAL_LINK = /!?\[([^\]]*)\]\((?:file:\/\/|\/(?:Users|home|private|tmp|var|Volumes)\/|[A-Za-z]:\\)[^)]*\)/g;

/** Markdown with its local file paths replaced; a link to a local file keeps only its text. */
export function redactLocalPaths(markdown: string): string {
  return markdown.replace(LOCAL_LINK, "$1").replace(LOCAL_PATH, "[local file]").replace(WINDOWS_PATH, "[local file]");
}

/** Transcript references show a useful file/directory name without revealing the machine's absolute path. */
export function displayLocalPaths(markdown: string): string {
  const name = (path: string) => basename(path.replace(/^file:\/\//, "").replace(/:\d+(?::\d+)?$/, ""));
  return markdown.replace(LOCAL_PATH, name).replace(WINDOWS_PATH, (path) => name(path.replaceAll("\\", "/")));
}

/** A small display excerpt, never Markdown, tool output or a local file link. */
export function previewText(text: string): string {
  const plain = text
    .replace(/\s*\(disable recaps in \/config\)\s*$/i, "")
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(LOCAL_PATH, "[local file]")
    .replace(WINDOWS_PATH, "[local file]")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length <= PREVIEW_LIMIT ? plain : `${plain.slice(0, PREVIEW_LIMIT - 1).trimEnd()}…`;
}

const recap = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literal("away_summary"),
  content: Schema.String,
  timestamp: Schema.optional(Schema.String),
  isSidechain: Schema.optional(Schema.Boolean),
});
const claudeReply = Schema.Struct({
  type: Schema.Literal("assistant"),
  timestamp: Schema.optional(Schema.String),
  isSidechain: Schema.optional(Schema.Boolean),
  message: Schema.Struct({
    content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
  }),
});
const response = Schema.Struct({
  type: Schema.Literal("response_item"),
  timestamp: Schema.optional(Schema.String),
  payload: Schema.Struct({
    type: Schema.Literal("message"),
    role: Schema.Literal("assistant"),
    phase: Schema.optional(Schema.String),
    channel: Schema.optional(Schema.String),
    content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
  }),
});
const decodeRecap = Schema.decodeUnknownOption(recap);
const decodeClaudeReply = Schema.decodeUnknownOption(claudeReply);
const decodeResponse = Schema.decodeUnknownOption(response);

/**
 * Claude's displayed recap and Codex's completed response, from their actual transcript records.
 * A Claude session with no recap yet falls back to Claude's last reply, as Codex does.
 */
export function sessionPreview(tool: "claude" | "codex", records: unknown[]): SessionPreview | undefined {
  let latest: SessionPreview | undefined;
  let reply: SessionPreview | undefined;
  for (const record of records) {
    if (tool === "claude") {
      const parsed = decodeClaudeReply(record);
      if (Option.isSome(parsed) && !parsed.value.isSidechain) {
        const preview = previewText(
          parsed.value.message.content
            .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
            .join("\n"),
        );
        const at = parsed.value.timestamp ? Date.parse(parsed.value.timestamp) : 0;
        if (preview) reply = { preview, previewKind: "response", previewAt: Number.isFinite(at) ? at : 0 };
        continue;
      }
    }
    let text: string;
    let timestamp: string | undefined;
    if (tool === "claude") {
      const parsed = decodeRecap(record);
      if (Option.isNone(parsed) || parsed.value.isSidechain) continue;
      ({ content: text, timestamp } = parsed.value);
    } else {
      const parsed = decodeResponse(record);
      if (Option.isNone(parsed)) continue;
      const { payload } = parsed.value;
      // Commentary, analysis, tools and compaction summaries are not the last answer.
      if (payload.phase && payload.phase !== "final_answer") continue;
      if (payload.channel && payload.channel !== "final") continue;
      text = payload.content
        .flatMap((part) => (part.type === "output_text" && part.text ? [part.text] : []))
        .join("\n");
      timestamp = parsed.value.timestamp;
    }
    const preview = previewText(text);
    if (!preview) continue;
    const parsedAt = timestamp ? Date.parse(timestamp) : 0;
    const previewAt = Number.isFinite(parsedAt) ? parsedAt : 0;
    if (!latest || previewAt >= latest.previewAt)
      latest = { preview, previewKind: tool === "claude" ? "recap" : "response", previewAt };
  }
  return latest ?? reply;
}
