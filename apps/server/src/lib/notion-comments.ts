// Notion comment threads, parsed from the MCP get-comments XML. No "@/" imports, so tests can import it.
import { toReply, type Reply } from "./people.ts";

type NotionComment = { userId: string; from: string; at: Date; url: string };
export type Discussion = { resolved: boolean; comments: NotionComment[] };

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

/** Discussions in page order. A comment's user-url is "user://<id>/<email>"; `from` is the email, which people.ts maps to a name. */
export function parseDiscussions(xml: string): Discussion[] {
  return [...xml.matchAll(/<discussion\b([^>]*)>([\s\S]*?)<\/discussion>/g)].map(([, discussionAttrs, body]) => ({
    resolved: attr(discussionAttrs, "resolved") === "true",
    comments: [...body.matchAll(/<comment\b([^>]*)>/g)].flatMap(([, a]) => {
      const user = attr(a, "user-url");
      const at = attr(a, "datetime");
      const url = attr(a, "url");
      if (!user || !at || !url) return [];
      const [userId, email] = user.replace("user://", "").split("/");
      return [{ userId, from: email ? email : "someone", at: new Date(at), url }];
    }),
  }));
}

/**
 * Open threads where someone else has the last word and it is yours to answer:
 * you own the doc, or you wrote in that thread. Answering or resolving a thread clears it.
 */
export function notionReply(discussions: Discussion[], me: string, owner: boolean): Reply | null {
  return toReply(
    discussions.flatMap((d) => {
      const last = d.comments.at(-1);
      if (d.resolved || !last || last.userId === me) return [];
      return owner || d.comments.some((c) => c.userId === me) ? [last] : [];
    }),
  );
}
