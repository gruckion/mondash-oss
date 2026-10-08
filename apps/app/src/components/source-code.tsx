import { useEffect, useMemo, useRef } from "react";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import swift from "highlight.js/lib/languages/swift";
import sql from "highlight.js/lib/languages/sql";
import markdown from "highlight.js/lib/languages/markdown";
import type { ConversationEdit } from "@mondash/shared/contract";

for (const [name, grammar] of Object.entries({
  typescript,
  javascript,
  json,
  python,
  bash,
  css,
  xml,
  swift,
  sql,
  markdown,
}))
  hljs.registerLanguage(name, grammar);
hljs.registerLanguage("conversation-shell", (api) => ({
  ...bash(api),
  contains: [{ scope: "built_in", begin: /^[ \t]*[\w./-]+(?=\s)/ }, ...bash(api).contains!],
}));
const LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  py: "python",
  sh: "bash",
  zsh: "bash",
  bash: "bash",
  css: "css",
  html: "xml",
  xml: "xml",
  swift: "swift",
  sql: "sql",
  md: "markdown",
};
export function fileLanguage(name: string) {
  return LANG[name.split(".").at(-1)!.toLowerCase()];
}
export function FileIcon({ name }: { name: string }) {
  const ext = name.split(".").at(-1)?.toUpperCase();
  if (ext === "MD" || ext === "MARKDOWN")
    return (
      <svg
        className="source-file-icon source-file-icon-document"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
        <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      </svg>
    );
  return (
    <span className={`source-file-icon${ext === "JSON" ? " source-file-icon-json" : ""}`} aria-hidden="true">
      {ext === "JSON" ? "{}" : ext && ext.length <= 4 ? ext : "▤"}
    </span>
  );
}
const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Fenced Markdown uses the same bounded, escaped grammars as the source pane. */
export function highlightCode(text: string, language: string) {
  const name = LANG[language.toLowerCase()] ?? language.toLowerCase();
  return hljs.getLanguage(name)
    ? hljs.highlight(text, { language: name === "bash" ? "conversation-shell" : name, ignoreIllegals: true }).value
    : escape(text);
}
function highlighted(text: string, name: string) {
  const language = fileLanguage(name);
  return language ? hljs.highlight(text, { language, ignoreIllegals: true }).value : escape(text);
}
/** Retain multiline grammar state while making independently numbered HTML rows. */
function highlightedLines(text: string, name: string) {
  const rows = highlighted(text, name).split("\n");
  let stack: string[] = [];
  return rows.map((row) => {
    const start = stack.join("");
    for (const tag of row.matchAll(/<span\b[^>]*>|<\/span>/g)) {
      if (tag[0] === "</span>") stack.pop();
      else stack.push(tag[0]);
    }
    return start + row + "</span>".repeat(stack.length);
  });
}
export function SourceCode({ text, name, line }: { text: string; name: string; line?: number }) {
  const target = useRef<HTMLDivElement>(null);
  const clipped = text.length > 300_000;
  const rows = useMemo(() => highlightedLines(text.slice(0, 300_000), name), [text, name]);
  const targetLine = line ? Math.min(line, rows.length) : undefined;
  useEffect(() => {
    target.current?.scrollIntoView({ block: "center", inline: "nearest" });
  }, [line, text]);
  return (
    <div className="source-code" aria-label={`Source of ${name}`}>
      {rows.map((html, index) => (
        <div
          key={index}
          ref={targetLine === index + 1 ? target : undefined}
          className={`source-line${targetLine === index + 1 ? " selected" : ""}`}
        >
          <span className="source-line-number">{index + 1}</span>
          <code dangerouslySetInnerHTML={{ __html: html || " " }} />
        </div>
      ))}
      {line && line > rows.length && (
        <p className="source-limit">
          Line {line} is beyond the current file ({rows.length} lines). Showing the end of the file.
        </p>
      )}
      {clipped && <p className="source-limit">Preview limited to the first 300,000 characters.</p>}
    </div>
  );
}
export function DiffCode({
  edit,
  source,
  compact = false,
}: {
  edit: ConversationEdit;
  source?: string;
  compact?: boolean;
}) {
  const rows = useMemo(() => diffRows(edit, source), [edit, source]);
  return (
    <div
      className={`source-code source-diff${compact ? " compact" : ""}`}
      aria-label={`Changes to ${edit.file.path ?? edit.file.name}`}
    >
      {rows.slice(0, compact ? 8 : 1000).map((row, index) => (
        <div key={index} className={`source-line ${row.kind}`}>
          <span className="source-line-number">{row.number ?? ""}</span>
          <span className="source-diff-sign">{row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " "}</span>
          <code dangerouslySetInnerHTML={{ __html: row.html || " " }} />
        </div>
      ))}
      {compact && rows.length > 8 && <div className="source-limit">More changes…</div>}
    </div>
  );
}

function diffRows(edit: ConversationEdit, source?: string) {
  const hunks = edit.diff.split(/(?=^@@)/m);
  let searchFrom = 0;
  return hunks.flatMap((hunk) => {
    let old: number | undefined;
    let next: number | undefined;
    const patch = hunk.split("\n").filter((row) => row.length > 0);
    const numbers = patch[0]?.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
    if (numbers) {
      old = Number(numbers[1]);
      next = Number(numbers[2]);
    } else {
      const sequence = patch
        .filter((row) => row.startsWith("+") || row.startsWith(" "))
        .map((row) => row.slice(1))
        .join("\n");
      const at = source && sequence ? source.indexOf(sequence, searchFrom) : -1;
      if (at >= 0) {
        old = next = source!.slice(0, at).split("\n").length;
        searchFrom = at + sequence.length;
      }
    }
    return patch.flatMap((row) => {
      if (row.startsWith("@@")) return [];
      const kind = row.startsWith("+") ? "added" : row.startsWith("-") ? "removed" : "context";
      const oldLine = kind !== "added" ? old : undefined;
      const newLine = kind !== "removed" ? next : undefined;
      if (kind !== "added" && old !== undefined) old++;
      if (kind !== "removed" && next !== undefined) next++;
      return [
        { kind, number: kind === "removed" ? oldLine : newLine, html: highlighted(row.slice(1), edit.file.name) },
      ];
    });
  });
}
