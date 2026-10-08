import { isAbsolute } from "node:path";
import { Option, Schema } from "effect";
import type { ConversationEdit } from "@mondash/shared/contract";
import { attachmentSource, type AttachmentSource } from "./session-attachments";
import { fileDisplayPath } from "./session-files";

const Part = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Unknown),
  tool_use_id: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Unknown),
  is_error: Schema.optional(Schema.Boolean),
});
const decode = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literals(["assistant", "user"]),
    timestamp: Schema.optional(Schema.String),
    isSidechain: Schema.optional(Schema.Boolean),
    isMeta: Schema.optional(Schema.Boolean),
    isCompactSummary: Schema.optional(Schema.Boolean),
    toolUseResult: Schema.optional(Schema.Unknown),
    message: Schema.Struct({
      content: Schema.Array(Part),
      stop_reason: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  }),
);
const decodePath = Schema.decodeUnknownOption(Schema.Struct({ file_path: Schema.String }));
const decodeReceipt = Schema.decodeUnknownOption(
  Schema.Struct({
    filePath: Schema.String,
    type: Schema.optional(Schema.String),
    content: Schema.optional(Schema.String),
    structuredPatch: Schema.optional(
      Schema.Array(
        Schema.Struct({
          oldStart: Schema.Int,
          oldLines: Schema.Int,
          newStart: Schema.Int,
          newLines: Schema.Int,
          lines: Schema.Array(Schema.String),
        }),
      ),
    ),
  }),
);

type ToolEvent =
  | { kind: "call"; id: string; name: string; input: unknown; timestamp?: string }
  | { kind: "result"; id: string; output: unknown; failed: boolean; receipt: unknown; timestamp?: string };

/** Mixed assistant messages retain the provider's text/tool block order. */
export function claudeOrderedRecords(record: unknown): unknown[] {
  const parsed = decode(record);
  if (
    Option.isNone(parsed) ||
    parsed.value.type !== "assistant" ||
    !parsed.value.message.content.some((part) => part.type === "tool_use")
  )
    return [record];
  return parsed.value.message.content.map((part) => ({
    ...parsed.value,
    message: { ...parsed.value.message, content: [part] },
  }));
}

/** Claude's provider receipts, never the current checkout or another session's git diff. */
export function claudeToolEvents(record: unknown): ToolEvent[] {
  const parsed = decode(record);
  if (Option.isNone(parsed) || parsed.value.isSidechain || parsed.value.isMeta || parsed.value.isCompactSummary)
    return [];
  const { type, timestamp, message, toolUseResult } = parsed.value;
  return message.content.flatMap<ToolEvent>((part) => {
    if (type === "assistant" && part.type === "tool_use" && part.id && part.name)
      return [{ kind: "call" as const, id: part.id, name: part.name, input: part.input, timestamp }];
    if (type === "user" && part.type === "tool_result" && part.tool_use_id)
      return [
        {
          kind: "result" as const,
          id: part.tool_use_id,
          output: part.content,
          failed: part.is_error === true,
          receipt: toolUseResult,
          timestamp,
        },
      ];
    return [];
  });
}

export function claudeRecordedEdits(
  name: string,
  input: unknown,
  receipt: unknown,
  root?: string,
): { edit: ConversationEdit; source: AttachmentSource }[] {
  if (!["Edit", "Write", "MultiEdit"].includes(name)) return [];
  const path = decodePath(input);
  const parsed = decodeReceipt(receipt);
  if (
    Option.isNone(path) ||
    Option.isNone(parsed) ||
    path.value.file_path !== parsed.value.filePath ||
    !isAbsolute(parsed.value.filePath)
  )
    return [];
  const result = parsed.value;
  const diff =
    (result.structuredPatch?.length ? result.structuredPatch : undefined)
      ?.map(
        (hunk) =>
          `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join("\n")}`,
      )
      .join("\n") ??
    (name === "Write" && result.type === "create" && result.content
      ? `@@ -0,0 +1,${result.content.replace(/\n$/, "").split("\n").length} @@\n${result.content
          .replace(/\n$/, "")
          .split("\n")
          .map((line) => `+${line}`)
          .join("\n")}`
      : "");
  if (!diff || diff.length > 20_000) return [];
  const source = attachmentSource(result.filePath);
  source.attachment = { ...source.attachment, path: fileDisplayPath(result.filePath, root), inline: true };
  return [
    {
      source,
      edit: {
        file: source.attachment,
        diff,
        additions: diff.split("\n").filter((line) => line.startsWith("+")).length,
        deletions: diff.split("\n").filter((line) => line.startsWith("-")).length,
      },
    },
  ];
}
