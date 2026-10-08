import type { Card, Row } from "./contract";

/** Identities and direct links only. Sharing a neighbour does not make two items related. */
export type ItemScope = { readonly keys: readonly string[]; readonly links: readonly string[] };
const unique = (keys: readonly (string | undefined)[]) => [...new Set(keys.filter((key) => key !== undefined))];
const ticketKey = (id?: string) => (id && /^[A-Z]+-\d+$/i.test(id) ? `ticket:${id.toUpperCase()}` : undefined);

export function itemUrlKey(value?: string): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, "");
    if (url.hostname === "linear.app") {
      const id = path.match(/\/issue\/([A-Z]+-\d+)(?:\/|$)/i)?.[1];
      if (id) return ticketKey(id);
    }
    if (/(^|\.)notion\.(so|com|site)$/.test(url.hostname)) {
      const id = path.match(/([a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i)?.[1];
      if (id) return `notion:${id.replace(/-/g, "").toLowerCase()}`;
    }
    // Replies belong to the parent thread, even when their permalink names another message.
    const channel = /^[a-z0-9-]+\.slack\.com$/i.test(url.hostname)
      ? path.match(/^\/archives\/([CDG][A-Z0-9]+)\/p\d{16}$/i)?.[1]
      : undefined;
    const thread = url.searchParams.get("thread_ts");
    if (channel && thread && /^\d{10}\.\d{6}$/.test(thread))
      return `${url.host}/archives/${channel}/p${thread.replace(".", "")}`.toLowerCase();
    // A comment, diff or query still names the same PR. Include owner/repository, never just core#123.
    const pr = path.match(/^(\/[^/]+\/[^/]+\/pull\/\d+)(?:\/|$)/i)?.[1];
    return `${url.host}${pr ?? path}`.toLowerCase();
  } catch {
    return;
  }
}

export function rowScope(row: Row, owners: readonly Card[] = []): ItemScope {
  return {
    keys: unique([itemUrlKey(row.url), row.kind === "ticket" ? ticketKey(row.reference ?? row.title) : undefined]),
    // linkTicketId is a suggestion awaiting "Link", not evidence that the thread is linked.
    links: unique(owners.flatMap((card) => cardScope(card).keys)),
  };
}

export function cardScope(card: Card): ItemScope {
  return {
    keys: unique([itemUrlKey(card.url), card.kind === "issue" ? ticketKey(card.id) : undefined]),
    links: unique([
      ...(card.rows ?? []).flatMap((row) => rowScope(row).keys),
      ...card.links.map((link) => itemUrlKey(link.url)),
      ...card.related.map((link) => itemUrlKey(link.url)),
    ]),
  };
}

export function inItemScope(active: ItemScope | null, target: ItemScope): boolean {
  return (
    !!active &&
    (target.keys.some((key) => active.keys.includes(key) || active.links.includes(key)) ||
      active.keys.some((key) => target.links.includes(key)))
  );
}
