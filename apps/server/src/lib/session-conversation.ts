import { createHash } from "node:crypto";
import { Option, Schema } from "effect";
import type { ConversationTurn } from "@mondash/shared/contract";
import { displayLocalPaths } from "./session-preview";
import { extractAttachments, type AttachmentSource } from "./session-attachments";
import { codexRunning } from "./session-activity";
import { claudeToolEvents, claudeRecordedEdits, claudeOrderedRecords } from "./claude-session-tools";
import {
  recordedEdits,
  sessionRoot,
  fileDisplayPath,
  patchSucceeded,
  recordedFileLines,
  numberedEdit,
} from "./session-files";

/** The most recent turns sent. A turn is one message, or an agent's run of messages between two of yours. */
export const TURN_LIMIT = 30;
/** Characters kept of one turn. A long answer keeps its end, where the result is; a long prompt keeps its start. */
export const TURN_TEXT_LIMIT = 20_000;
/** Bytes of text sent in all; older turns are left out to fit. */
export const TOTAL_LIMIT = 200_000;

const Part = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
  image_url: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Unknown),
});
const decodeClaudeImage = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal("base64"), media_type: Schema.String, data: Schema.String }),
);
const claudeMessage = Schema.Struct({
  type: Schema.Literals(["user", "assistant"]),
  timestamp: Schema.optional(Schema.String),
  isSidechain: Schema.optional(Schema.Boolean),
  // Text Claude Code adds for the model: command output, images, messages from other sessions.
  isMeta: Schema.optional(Schema.Boolean),
  isCompactSummary: Schema.optional(Schema.Boolean),
  message: Schema.Struct({
    content: Schema.Union([Schema.String, Schema.Array(Part)]),
    stop_reason: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});
const codexMessage = Schema.Struct({
  type: Schema.Literal("response_item"),
  timestamp: Schema.optional(Schema.String),
  payload: Schema.Struct({
    type: Schema.Literal("message"),
    role: Schema.String,
    channel: Schema.optional(Schema.String),
    phase: Schema.optional(Schema.String),
    content: Schema.Array(Part),
  }),
});
const decodeClaude = Schema.decodeUnknownOption(claudeMessage);
const decodeCodex = Schema.decodeUnknownOption(codexMessage);

type Said = {
  role: "user" | "assistant";
  text: string;
  timestamp: string | undefined;
  sources?: AttachmentSource[];
  phase?: ConversationTurn["phase"];
  context?: string;
};

/** Text you typed: not injected context ("<environment_context>", "<system-reminder>"), nor an interruption note. */
const typed = (text: string) => {
  const trimmed = text.trim();
  return trimmed.startsWith("<") || trimmed.startsWith("[Request interrupted by user") ? "" : trimmed;
};

function claudeSaid(record: unknown): Said | undefined {
  const parsed = decodeClaude(record);
  if (Option.isNone(parsed)) return undefined;
  const { type, timestamp, isSidechain, isMeta, isCompactSummary, message } = parsed.value;
  if (isSidechain || isMeta || isCompactSummary) return undefined;
  const parts = typeof message.content === "string" ? [message.content] : textParts(message.content, "text");
  const text = (
    type === "user"
      ? parts.map((part) => {
          const pasted = /^\s*<pasted_content\s+id="[^"]*">/.test(part);
          const text = part
            .replace(/^<\/?pasted_content(?:\s+id="[^"]*")?>\r?\n?/gm, "")
            .replace(/<\/?pasted_content(?:\s+id="[^"]*")?>/g, "");
          return pasted ? text.trim() : typed(text);
        })
      : parts.map((part) => part.trim())
  )
    .filter(Boolean)
    .join("\n\n");
  const images =
    typeof message.content === "string"
      ? []
      : message.content.flatMap((part) => {
          if (part.type !== "image") return [];
          const image = decodeClaudeImage(part.source);
          return Option.isSome(image) ? [`data:${image.value.media_type};base64,${image.value.data}`] : [];
        });
  const found = extractAttachments(text, images);
  return found.text || found.sources.length
    ? {
        role: type,
        text: found.text,
        timestamp,
        sources: found.sources,
        ...(type === "assistant" && message.stop_reason
          ? ({ phase: message.stop_reason === "end_turn" ? "final" : "commentary" } as const)
          : {}),
      }
    : undefined;
}

function codexSaid(record: unknown): Said | undefined {
  const parsed = decodeCodex(record);
  if (Option.isNone(parsed)) return undefined;
  const { payload, timestamp } = parsed.value;
  // Developer instructions and reasoning are not the conversation.
  if (payload.role !== "user" && payload.role !== "assistant") return undefined;
  if (payload.role === "assistant" && payload.channel && !["final", "commentary"].includes(payload.channel))
    return undefined;
  let text = textParts(payload.content, payload.role === "user" ? "input_text" : "output_text")
    .map(payload.role === "user" ? typed : (part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
  const instructions = payload.role === "user" ? text.match(/^# AGENTS\.md instructions for (.+)\n/) : null;
  const context = instructions ? displayLocalPaths(`AGENTS.md · ${instructions[1]!.trim()}`) : undefined;
  if (instructions)
    text = text
      .slice(instructions[0].length)
      .replace(/<\/?INSTRUCTIONS>/g, "")
      .replace(/--- project-doc ---/g, "---");
  const phase =
    payload.role === "assistant"
      ? payload.phase === "final_answer" || payload.channel === "final"
        ? "final"
        : payload.phase === "commentary" || payload.channel === "commentary"
          ? "commentary"
          : undefined
      : undefined;
  const found = extractAttachments(
    text,
    payload.content.flatMap((part) => (part.type === "input_image" && part.image_url ? [part.image_url] : [])),
  );
  return found.text || found.sources.length
    ? { role: payload.role, text: found.text, timestamp, sources: found.sources, phase, context }
    : undefined;
}

const ToolRecord = Schema.Struct({
  type: Schema.Literal("response_item"),
  timestamp: Schema.optional(Schema.String),
  payload: Schema.Struct({
    type: Schema.Literals(["function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"]),
    call_id: Schema.String,
    name: Schema.optional(Schema.String),
    namespace: Schema.optional(Schema.String),
    arguments: Schema.optional(Schema.String),
    input: Schema.optional(Schema.String),
    output: Schema.optional(Schema.Unknown),
  }),
});
const decodeTool = Schema.decodeUnknownOption(ToolRecord);
const decodeCommand = Schema.decodeUnknownOption(
  Schema.Struct({ cmd: Schema.optional(Schema.String), command: Schema.optional(Schema.String) }),
);
const toolLabel = (input: string): string | undefined => {
  try {
    const parsed = decodeCommand(JSON.parse(input));
    if (Option.isSome(parsed)) {
      const command = parsed.value.cmd ?? parsed.value.command;
      if (command) return displayLocalPaths(command).slice(0, 240);
    }
  } catch {
    /* Custom tools carry source text rather than JSON. */
  }
  const commands = [...input.matchAll(/(?:cmd|command):\s*("(?:\\.|[^"\\])*")/g)].flatMap((match) => {
    try {
      const value: unknown = JSON.parse(match[1]!);
      return typeof value === "string" ? [value] : [];
    } catch {
      return [];
    }
  });
  return commands.length
    ? `${displayLocalPaths(commands[0]!).slice(0, 220)}${commands.length > 1 ? ` · ${commands.length - 1} more commands` : ""}`
    : undefined;
};
const TOOL_INPUT_LIMIT = 8_000;
const TOOL_OUTPUT_LIMIT = 16_000;
const toolText = (value: unknown, limit: number) => {
  const text = displayLocalPaths(typeof value === "string" ? value : (JSON.stringify(value) ?? ""));
  return text.length > limit ? `${text.slice(0, limit)}\n…` : text;
};

const textParts = (content: ReadonlyArray<typeof Part.Type>, type: string) =>
  content.flatMap((part) => (part.type === type && part.text ? [part.text] : []));

const isoTime = (timestamp: string | undefined) => {
  const at = timestamp ? Date.parse(timestamp) : Number.NaN;
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
};

const clip = (turn: ConversationTurn): ConversationTurn => {
  if (turn.text.length <= TURN_TEXT_LIMIT) return turn;
  const kept = TURN_TEXT_LIMIT - 1;
  return {
    ...turn,
    text: turn.role === "assistant" ? `…${turn.text.slice(-kept)}` : `${turn.text.slice(0, kept)}…`,
  };
};

const encoder = new TextEncoder();

/**
 * The recent conversation in a session's transcript records, oldest first: your prompts and the agent's answers as
 * Markdown and bounded tool details. Project instructions are marked as context; reasoning and raw local paths are excluded.
 */
export function conversation(
  tool: "claude" | "codex",
  records: ReadonlyArray<unknown>,
  attachmentSources?: Map<string, AttachmentSource>,
): { turns: ConversationTurn[]; truncated: boolean } {
  const all: ConversationTurn[] = [];
  const calls = new Map<string, number>();
  const identities = new Map<string, number>();
  const root = sessionRoot(records);
  const readInputs = new Map<string, string>();
  const fileLines = new Map<string, NonNullable<ReturnType<typeof recordedFileLines>>["lines"]>();
  const edits = new Map<string, ReturnType<typeof recordedEdits>>();
  const claudeInputs = new Map<string, unknown>();
  for (const record of tool === "claude" ? records.flatMap(claudeOrderedRecords) : records) {
    if (tool === "claude") {
      for (const event of claudeToolEvents(record)) {
        if (event.kind === "call") {
          if (calls.has(event.id)) continue;
          claudeInputs.set(event.id, event.input);
          calls.set(event.id, all.length);
          const input = toolText(event.input, TOOL_INPUT_LIMIT);
          const at = isoTime(event.timestamp);
          const label = toolLabel(JSON.stringify(event.input) ?? "");
          all.push({
            role: "assistant",
            text: event.name,
            ...(at ? { at } : {}),
            activity: {
              id: event.id,
              name: event.name,
              input,
              ...(label ? { label } : {}),
              status: "running",
            },
          });
        } else {
          const index = calls.get(event.id);
          const previous = index === undefined ? undefined : all[index];
          if (!previous?.activity || previous.activity.status !== "running") continue;
          const changes = event.failed
            ? []
            : claudeRecordedEdits(previous.activity.name, claudeInputs.get(event.id), event.receipt, root);
          for (const change of changes) attachmentSources?.set(change.source.attachment.id, change.source);
          all[index!] = {
            ...previous,
            ...(changes.length ? { edits: changes.map((change) => change.edit) } : {}),
            activity: { ...previous.activity, output: toolText(event.output, TOOL_OUTPUT_LIMIT), status: "completed" },
          };
        }
      }
    }
    if (tool === "codex") {
      const parsed = decodeTool(record);
      if (Option.isSome(parsed)) {
        const { payload, timestamp } = parsed.value;
        if (payload.type.endsWith("_output")) {
          const index = calls.get(payload.call_id);
          const previous = index === undefined ? undefined : all[index];
          if (previous?.activity) {
            const captured = recordedFileLines(readInputs.get(payload.call_id) ?? "", payload.output, root);
            if (captured) fileLines.set(captured.path, captured.lines);
            const output = toolText(payload.output, TOOL_OUTPUT_LIMIT);
            const changes = patchSucceeded(payload.output) ? (edits.get(payload.call_id) ?? []) : [];
            for (const change of changes) {
              attachmentSources?.set(change.source.attachment.id, change.source);
              fileLines.delete(change.source.source);
            }
            all[index!] = {
              ...previous,
              ...(changes.length ? { edits: changes.map((change) => change.edit) } : {}),
              activity: { ...previous.activity, output, status: "completed" },
            };
          }
        } else {
          const name = [payload.namespace, payload.name || "Tool"].filter(Boolean).join(".");
          const at = isoTime(timestamp);
          const label = toolLabel(payload.arguments ?? payload.input ?? "");
          readInputs.set(payload.call_id, payload.arguments ?? payload.input ?? "");
          edits.set(
            payload.call_id,
            recordedEdits(payload.arguments ?? payload.input ?? "", root).map((change) => {
              const captured = fileLines.get(change.source.source);
              return captured ? { ...change, edit: numberedEdit(change.edit, captured) } : change;
            }),
          );
          calls.set(payload.call_id, all.length);
          all.push({
            role: "assistant",
            text: name,
            ...(at ? { at } : {}),
            activity: {
              id: payload.call_id,
              name,
              ...(label ? { label } : {}),
              input: toolText(payload.arguments ?? payload.input ?? "", TOOL_INPUT_LIMIT),
              status: "running",
            },
          });
        }
        continue;
      }
    }
    const said = tool === "claude" ? claudeSaid(record) : codexSaid(record);
    if (!said) continue;
    const found = said.sources ? { text: said.text, sources: said.sources } : extractAttachments(said.text);
    for (const source of found.sources) {
      if (source.attachment.path)
        source.attachment = { ...source.attachment, path: fileDisplayPath(source.source, root) };
      attachmentSources?.set(source.attachment.id, source);
    }
    const attachments = found.sources.map((source) => source.attachment);
    const text = displayLocalPaths(found.text);
    const at = isoTime(said.timestamp);
    const identity = createHash("sha256")
      .update(JSON.stringify([said.role, said.timestamp, said.text]))
      .digest("hex");
    const occurrence = identities.get(identity) ?? 0;
    identities.set(identity, occurrence + 1);
    const id = `${identity}:${occurrence}`;
    const last = all.at(-1);
    // Tool calls split an answer into several messages; they read as one.
    if (
      tool === "claude" &&
      last &&
      last.role === said.role &&
      !last.activity &&
      !last.phase &&
      !said.phase &&
      !last.attachments &&
      !attachments.length
    )
      all[all.length - 1] = { ...last, text: `${last.text}\n\n${text}`, ...(at ? { at } : {}) };
    else
      all.push({
        ...(tool === "codex" ? { id } : {}),
        role: said.role,
        ...(said.phase ? { phase: said.phase } : {}),
        ...(said.context ? { context: said.context } : {}),
        text,
        ...(at ? { at } : {}),
        ...(attachments.length ? { attachments } : {}),
      });
  }
  const running = tool === "codex" ? codexRunning(records) : undefined;
  if (running === false) {
    for (let i = 0; i < all.length; i++) {
      const turn = all[i]!;
      if (turn.activity?.status === "running")
        all[i] = { ...turn, activity: { ...turn.activity, status: "interrupted" } };
    }
  }
  // Retain whole prompt/assistant groups. Tool rows are part of an assistant run, not separate turns.
  let start = all.length;
  let groups = 0;
  let role: ConversationTurn["role"] | undefined;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i]!.role !== role) {
      groups++;
      role = all[i]!.role;
    }
    if (groups > TURN_LIMIT) break;
    start = i;
  }
  const recent = all.slice(start).map(clip);
  const turns: ConversationTurn[] = [];
  let bytes = 0;
  let truncated = start > 0;
  // Messages take precedence over older command details, so a busy run cannot evict its prompt/images.
  for (const turn of recent.filter((turn) => !turn.activity).reverse()) {
    const size = encoder.encode(turn.text).length;
    if (bytes + size > TOTAL_LIMIT) {
      truncated = true;
      break;
    }
    bytes += size;
    turns.push(turn);
  }
  const messages = new Set(turns);
  const activities = new Map<string, ConversationTurn>();
  // Recorded edits must survive a later busy run filling the command-detail budget.
  const commands = recent.filter((turn) => turn.activity).reverse();
  for (const turn of [
    ...commands.filter((turn) => turn.edits?.length),
    ...commands.filter((turn) => !turn.edits?.length),
  ]) {
    const activity = turn.activity!;
    const size = encoder.encode(
      turn.text + activity.input + (activity.output ?? "") + JSON.stringify(turn.edits ?? []),
    ).length;
    if (bytes + size <= TOTAL_LIMIT) {
      bytes += size;
      activities.set(activity.id, turn);
    } else {
      const summary = "Earlier command details are not shown.";
      const retainedEdits =
        bytes + encoder.encode(turn.text + summary + JSON.stringify(turn.edits ?? [])).length <= TOTAL_LIMIT
          ? turn.edits
          : undefined;
      const size = encoder.encode(turn.text + summary + JSON.stringify(retainedEdits ?? [])).length;
      if (bytes + size > TOTAL_LIMIT) {
        truncated = true;
        continue;
      }
      bytes += size;
      activities.set(activity.id, {
        ...turn,
        edits: retainedEdits,
        activity: { ...activity, input: summary, output: undefined },
      });
      truncated = true;
    }
  }
  return {
    turns: recent.flatMap((turn) =>
      turn.activity
        ? activities.has(turn.activity.id)
          ? [activities.get(turn.activity.id)!]
          : []
        : messages.has(turn)
          ? [turn]
          : [],
    ),
    truncated,
  };
}
