import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { Effect, Option, Schema } from "effect";
import { Store, storeKey } from "@/services/store";
import { redactLocalPaths } from "./session-preview";

const Message = Schema.Struct({
  role: Schema.Literals(["user", "assistant", "context"]),
  text: Schema.String,
  at: Schema.String,
});
export type EvidenceMessage = typeof Message.Type;
const Index = Schema.Struct({
  size: Schema.Finite,
  mtime: Schema.Finite,
  inode: Schema.Finite,
  offset: Schema.Finite,
  boundary: Schema.String,
  messages: Schema.Array(Message),
});
const Content = Schema.Union([
  Schema.String,
  Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
]);
const decode = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.String,
    timestamp: Schema.optional(Schema.String),
    isSidechain: Schema.optional(Schema.Boolean),
    isMeta: Schema.optional(Schema.Boolean),
    isCompactSummary: Schema.optional(Schema.Boolean),
    message: Schema.optional(Schema.Struct({ content: Content })),
    payload: Schema.optional(
      Schema.Struct({
        type: Schema.String,
        role: Schema.optional(Schema.String),
        channel: Schema.optional(Schema.String),
        content: Schema.optional(Content),
      }),
    ),
  }),
);
const injected = (text: string) =>
  /^(?:<(?:INSTRUCTIONS|user_instructions|environment_context|system-reminder|permissions|collaboration_mode|subagent_notification|user_shell_command|turn_aborted|external_codex_apps_[a-z_]+|command-name|command-message|local-command-stdout|local-command-caveat|task-notification|ide_opened_file)\b|# AGENTS\.md instructions\b|\[Request interrupted|Another Claude session sent a message:)/i.test(
    text.trim(),
  );

/** Strip machine paths and common credentials before either evidence pass leaves this machine. */
export function cleanEvidence(text: string): string {
  if (injected(text)) return "";
  return redactLocalPaths(text)
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]+)/g,
      "[REDACTED]",
    )
    .replace(
      /(\b[\w.-]*(?:api[_-]?key|token|password|secret)[\w.-]*["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s"',;}]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/(\bBearer\s+)[A-Za-z0-9._~-]+/gi, "$1[REDACTED]")
    .trim();
}
function message(raw: unknown, tool: "claude" | "codex"): EvidenceMessage | undefined {
  const parsed = decode(raw);
  if (Option.isNone(parsed)) return;
  const row = parsed.value;
  const codex = tool === "codex";
  if (codex ? row.type !== "response_item" || row.payload?.type !== "message" : row.isSidechain || row.isMeta) return;
  const role = codex ? row.payload?.role : row.type;
  if (role !== "user" && role !== "assistant") return;
  const channel = row.payload?.channel;
  if (codex && channel && !["final", "commentary", "summary"].includes(channel)) return;
  const content = codex ? row.payload?.content : row.message?.content;
  if (!content) return;
  const parts =
    typeof content === "string"
      ? [content]
      : content.flatMap((p) => (["text", "input_text", "output_text"].includes(p.type) && p.text ? [p.text] : []));
  const text = parts.map(cleanEvidence).filter(Boolean).join("\n");
  if (!text) return;
  const context = row.isCompactSummary || channel === "summary" || text.startsWith("This session is being continued");
  return { role: context ? "context" : role, text, at: row.timestamp ?? "" };
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Incremental local index: retain natural messages, never raw tool results or injected instructions. */
export const readEvidence = Effect.fn("session-evidence.read")(function* (file: string, tool: "claude" | "codex") {
  const store = yield* Store;
  const key = storeKey(`session-evidence:v1:${tool}:${file}`, Index);
  const previous = (yield* store.read(key))?.value;
  const next = yield* Effect.tryPromise(async () => {
    const handle = await open(file, "r");
    try {
      const info = await handle.stat();
      if (previous && previous.inode === info.ino && previous.size === info.size && previous.mtime === info.mtimeMs)
        return previous;
      const boundary = async (offset: number) => {
        const bytes = Buffer.alloc(Math.min(256, offset));
        await handle.read(bytes, 0, bytes.length, offset - bytes.length);
        return hash(bytes);
      };
      const append =
        previous &&
        previous.inode === info.ino &&
        info.size > previous.size &&
        (await boundary(previous.offset)) === previous.boundary;
      let offset = append ? previous.offset : 0;
      const messages = append ? [...previous.messages] : [];
      // Scan bytes so an unfinished UTF-8/JSON line is retried intact after the next append.
      let pending = Buffer.alloc(0);
      let oversized = false;
      const buffer = Buffer.alloc(64 * 1024);
      for (let position = offset; position < info.size;) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - position), position);
        if (!bytesRead) break;
        let start = 0;
        for (let i = 0; i < bytesRead; i++) {
          if (buffer[i] !== 10) continue;
          const chunk = buffer.subarray(start, i);
          if (!oversized && pending.length + chunk.length <= 4 * 1024 * 1024) {
            try {
              const found = message(JSON.parse(Buffer.concat([pending, chunk]).toString("utf8")), tool);
              if (found) messages.push(found);
            } catch {
              /* Interrupted/corrupt records are not conversation evidence. */
            }
          }
          pending = Buffer.alloc(0);
          oversized = false;
          offset = position + i + 1;
          start = i + 1;
        }
        if (!oversized) {
          const remainder = buffer.subarray(start, bytesRead);
          if (pending.length + remainder.length > 4 * 1024 * 1024) {
            oversized = true;
            pending = Buffer.alloc(0);
          } else pending = Buffer.concat([pending, remainder]);
        }
        position += bytesRead;
      }
      return {
        size: info.size,
        mtime: info.mtimeMs,
        inode: info.ino,
        offset,
        boundary: await boundary(offset),
        messages,
      };
    } finally {
      await handle.close();
    }
  });
  if (next !== previous) yield* store.write(key, next);
  return next.messages;
});

/** Continuation files may overlap; deduplicate their messages without letting summaries own an assistant reply. */
export function mergeEvidence(parts: readonly (readonly EvidenceMessage[])[]): EvidenceMessage[] {
  const seen = new Set<string>();
  return parts
    .flat()
    .sort((a, b) => a.at.localeCompare(b.at))
    .filter((message) => {
      const identity = JSON.stringify([message.role, message.at, message.text]);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
}
