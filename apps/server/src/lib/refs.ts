// References to work items found in text: ticket IDs, PR links, Slack threads and Notion pages.
// No "@/" imports, so tests can import it.

/** How many times each reference appears. Keys look like "ticket:DEMO-4188", "pr:ExampleOrg/core#2231". */
export type Refs = Record<string, number>;

const PATTERNS: [RegExp, (m: RegExpExecArray) => string][] = [
  // Also matches branch names like demo-4188-cancel-appointments. Non-ticket words like ISO-8601 match too; callers filter by team prefix.
  [/\b([A-Z]{2,6}-\d{1,6})\b/gi, (m) => `ticket:${m[1].toUpperCase()}`],
  [/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g, (m) => `pr:${m[1]}#${m[2]}`],
  // A reply's link carries its thread in thread_ts; a parent message's link is the thread itself.
  [
    /archives\/(\w+)\/p(\d{10})(\d{6})(?:[^\s"'<>\\]*?thread_ts=(\d+\.\d+))?/g,
    (m) => `slack:${m[1]}/${m[4] ? m[4] : `${m[2]}.${m[3]}`}`,
  ],
  [/notion\.(?:so|com|site)\/[^\s"'\\)]*?([0-9a-f]{32})/g, (m) => `notion:${m[1]}`],
];

export function countRefs(text: string): Refs {
  const refs: Refs = {};
  for (const [pattern, key] of PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      const k = key(m);
      refs[k] = (refs[k] ? refs[k] : 0) + 1;
    }
  }
  return refs;
}

/** The reference keys in one URL or ID, e.g. a ticket's PR link or Slack attachment. */
export const refKeys = (text: string) => Object.keys(countRefs(text));

/** A short label for Jev and people: "DEMO-4188", "core#2231", "Slack thread CDEMO123456/…", "Notion page". */
export function refLabel(key: string): string {
  const [kind, value] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  if (kind === "pr") return value.slice(value.indexOf("/") + 1);
  if (kind === "slack") return `Slack thread ${value}`;
  if (kind === "notion") return `Notion page ${value.slice(0, 8)}`;
  return value;
}

/** The items whose own references the session mentions at least once. */
export function candidates<T extends { refs: string[] }>(items: T[], session: Refs): T[] {
  return items.filter((item) => item.refs.some((key) => session[key] > 0));
}

/** Adds counts: a Codex session's files are counted one by one, then summed. */
export function addRefs(a: Refs, b: Refs): Refs {
  const sum: Refs = { ...a };
  for (const [k, n] of Object.entries(b)) sum[k] = (sum[k] ? sum[k] : 0) + n;
  return sum;
}
