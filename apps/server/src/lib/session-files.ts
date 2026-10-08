import { readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { Option, Schema } from "effect";
import type { ConversationEdit } from "@mondash/shared/contract";
import { attachmentSource, type AttachmentSource } from "./session-attachments";

const Cwd = Schema.Struct({ type: Schema.Literal("session_meta"), payload: Schema.Struct({ cwd: Schema.String }) });
const decodeCwd = Schema.decodeUnknownOption(Cwd);
const decodeClaudeCwd = Schema.decodeUnknownOption(Schema.Struct({ cwd: Schema.String }));
export function sessionRoot(records: readonly unknown[]): string | undefined {
  for (const record of records) {
    const found = decodeCwd(record);
    if (Option.isSome(found) && isAbsolute(found.value.payload.cwd)) return found.value.payload.cwd;
    const claude = decodeClaudeCwd(record);
    if (Option.isSome(claude) && isAbsolute(claude.value.cwd)) return claude.value.cwd;
  }
}
export function fileDisplayPath(path: string, root?: string): string {
  const within = root ? relative(root, path) : undefined;
  return within && within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within)
    ? within.split(sep).join("/")
    : basename(path);
}
const SKIP = new Set(["node_modules", "dist", "dist-ios", "build", "vendor", "Pods", "target"]);
const TEXT =
  /\.(?:[cm]?[jt]sx?|py|rb|rs|go|java|kt|swift|c|h|cpp|cs|php|sh|zsh|bash|md|txt|json|ya?ml|toml|xml|html?|css|scss|sql|graphql|vue|svelte|log|csv)$/i;
/** Only regular files under the transcript's project directory; no caller-supplied paths or symlink traversal. */
export async function workspaceFiles(root: string) {
  const base = await realpath(root);
  if (base === sep) throw new Error("This session has no project directory.");
  const sources = new Map<string, AttachmentSource>();
  let visited = 0;
  let truncated = false;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 16 || visited >= 10_000 || sources.size >= 5_000) {
      truncated = true;
      return;
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++visited > 10_000 || sources.size >= 5_000) {
        truncated = true;
        break;
      }
      if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (
        entry.isFile() &&
        (TEXT.test(entry.name) || ["Dockerfile", "Makefile", "LICENSE"].includes(entry.name))
      ) {
        const source = attachmentSource(path);
        source.root = base;
        source.attachment = { ...source.attachment, path: fileDisplayPath(path, base), inline: true };
        sources.set(source.attachment.id, source);
      }
    }
  };
  await walk(base, 0);
  return { root: basename(base), sources, truncated };
}

/** Parse recorded apply_patch input, including literal patches nested in functions.exec. Never execute tool source. */
export function recordedEdits(input: string, root?: string): { edit: ConversationEdit; source: AttachmentSource }[] {
  const patches: string[] = [];
  if (input.trim().startsWith("*** Begin Patch")) patches.push(input);
  for (const match of input.matchAll(/(?:tools\.)?apply_patch\(\s*("(?:\\.|[^"\\])*"|`[^`]*`)/g)) {
    try {
      patches.push(match[1]!.startsWith('"') ? JSON.parse(match[1]!) : match[1]!.slice(1, -1));
    } catch {
      /* Incomplete literal. */
    }
  }
  if (!patches.length && input.includes("*** Begin Patch")) {
    try {
      const parsed = Schema.decodeUnknownOption(Schema.Struct({ cmd: Schema.String }))(JSON.parse(input));
      if (Option.isSome(parsed)) patches.push(parsed.value.cmd);
    } catch {
      /* Not a JSON command. */
    }
  }
  const edits: { edit: ConversationEdit; source: AttachmentSource }[] = [];
  for (const patch of patches) {
    for (const match of patch.matchAll(
      /\*\*\* (Update|Add|Delete) File: ([^\n]+)\n([\s\S]*?)(?=\n\*\*\* (?:Update|Add|Delete) File:|\n\*\*\* End Patch|$)/g,
    )) {
      const path = isAbsolute(match[2]!) ? match[2]!.trim() : root ? resolve(root, match[2]!.trim()) : undefined;
      if (!path) continue;
      const diff = match[3]!
        .split("\n")
        .filter((line) => /^[ +\-@]/.test(line))
        .join("\n");
      if (!diff || diff.length > 20_000) continue;
      const source = attachmentSource(path);
      source.attachment = { ...source.attachment, path: fileDisplayPath(path, root), inline: true };
      edits.push({
        source,
        edit: {
          file: source.attachment,
          diff,
          additions: diff.split("\n").filter((line) => line.startsWith("+")).length,
          deletions: diff.split("\n").filter((line) => line.startsWith("-")).length,
        },
      });
    }
  }
  return edits.slice(0, 50);
}

const OutputParts = Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) }));
/** apply_patch returns an empty receipt through functions.exec, or a textual successful-file list. */
export function patchSucceeded(output: unknown): boolean {
  const parsed = Schema.decodeUnknownOption(OutputParts)(output);
  const parts = Option.isSome(parsed)
    ? parsed.value.flatMap((part) => (part.text ? [part.text] : []))
    : typeof output === "string"
      ? [output]
      : [];
  if (
    parts.some((part) =>
      /^(?:Error:\s*)?(?:Script running with cell ID|apply_patch verification failed|Invalid patch(?: text|:)|Failed to (?:find|read|apply))|"isError":\s*true/im.test(
        part,
      ),
    )
  )
    return false;
  return parts.some((part) => part.trim() === "{}" || /Success\. Updated the following files:/.test(part));
}

const CommandOutput = Schema.Struct({ output: Schema.String });
/** Command result envelopes may be nested in functions.exec's text parts. Only text output is decoded. */
export function recordedOutput(output: unknown): string {
  const parts = Schema.decodeUnknownOption(OutputParts)(output);
  const text = Option.isSome(parts)
    ? parts.value.flatMap((part) => (part.text ? [part.text] : [])).join("\n")
    : typeof output === "string"
      ? output
      : "";
  return text
    .split("\n")
    .map((line) => {
      try {
        const parsed = Schema.decodeUnknownOption(CommandOutput)(JSON.parse(line));
        return Option.isSome(parsed) ? parsed.value.output : line;
      } catch {
        return line;
      }
    })
    .join("\n");
}
export function recordedFileLines(input: string, output: unknown, root?: string) {
  const command = input.match(/nl\s+-ba\s+([^\s;"'\\)]+)/)?.[1];
  if (!command || (!isAbsolute(command) && !root)) return undefined;
  const lines = [...recordedOutput(output).matchAll(/^\s*(\d+)\t(.*)$/gm)].map((match) => ({
    number: Number(match[1]),
    text: match[2]!,
  }));
  return lines.length ? { path: isAbsolute(command) ? command : resolve(root!, command), lines } : undefined;
}
/** Use a captured, numbered pre-edit read for historical positions; never guess from the current checkout. */
export function numberedEdit(
  edit: ConversationEdit,
  lines: readonly { number: number; text: string }[],
): ConversationEdit {
  let offset = 0;
  const diff = edit.diff
    .split(/(?=^@@)/m)
    .map((hunk) => {
      const rows = hunk.split("\n");
      const before = rows.filter((row) => row.startsWith("-") || row.startsWith(" ")).map((row) => row.slice(1));
      const matches = lines.filter(
        (_, index) => before.length && before.every((text, at) => lines[index + at]?.text === text),
      );
      const afterCount = rows.filter((row) => row.startsWith("+") || row.startsWith(" ")).length;
      const start = matches.length === 1 ? matches[0]!.number : undefined;
      const result =
        start && rows[0]?.startsWith("@@")
          ? [`@@ -${start},${before.length} +${start + offset},${afterCount} @@`, ...rows.slice(1)].join("\n")
          : hunk;
      offset += afterCount - before.length;
      return result;
    })
    .join("");
  return { ...edit, diff };
}
