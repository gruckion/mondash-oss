// Web links rewritten to open in the desktop apps. No "@/" imports, so tests can import it.

/** A page title as Notion writes it in a URL: "Differentiate renewals from invoices" -> "Differentiate-renewals-from-invoices". */
const slug = (title: string) =>
  title
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");

/**
 * Notion: notion://, keeping the comment (?d=) and block (#) parts.
 * deepLinkOpenNewTab makes the app focus the tab already showing the page instead of replacing the tab you are on.
 * The app decides "same page" by the last path segment alone, and its own tabs use "Title-slug-<id>",
 * so the title goes in the link or it always opens another tab. Notion strips the parameter before navigating.
 */
export function notionAppUrl(url: string, title?: string): string {
  const u = new URL(url);
  const segment = u.pathname.split("/").filter(Boolean).at(-1);
  const match = segment?.match(/^(.*?)([0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i);
  const id = match?.[2].replaceAll("-", "").toLowerCase();
  if (!id) return url;
  u.searchParams.delete("pvs");
  u.searchParams.delete("source");
  u.searchParams.set("deepLinkOpenNewTab", "true");
  const page = title ? `${slug(title)}-${id}` : `${match?.[1] ?? ""}${id}`;
  return `notion://www.notion.so/${page}${u.search}${u.hash}`;
}

/** Slack: slack://channel with the message, and its thread for a reply. Slack needs the workspace (team) ID. */
export function slackAppUrl(url: string, team: string): string {
  const u = new URL(url);
  const match = u.pathname.match(/^\/archives\/([CDG][A-Z0-9]+)(?:\/p(\d{10})(\d{6}))?\/?$/);
  if (!match) return url;
  const params = new URLSearchParams({ team, id: match[1] });
  if (match[2]) params.set("message", `${match[2]}.${match[3]}`);
  const thread = u.searchParams.get("thread_ts");
  if (thread && !/^\d{10}\.\d{6}$/.test(thread)) return url;
  if (thread) params.set("thread_ts", thread);
  return `slack://channel?${params}`;
}

/** Linear: linear:// with the same path, e.g. linear://example/issue/DEMO-4188. */
export function linearAppUrl(url: string): string {
  const u = new URL(url);
  return u.hostname === "linear.app" ? `linear:/${u.pathname}${u.search}${u.hash}` : url;
}
