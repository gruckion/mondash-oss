import data from "@emoji-mart/data/sets/15/native.json";
import type { Skin } from "@emoji-mart/data";

const emojiSkins = new Map<string, readonly Skin[]>(
  Object.entries(data.emojis).map(([name, emoji]) => [name, emoji.skins]),
);
for (const [alias, name] of Object.entries(data.aliases)) {
  const skins = emojiSkins.get(name);
  if (skins) emojiSkins.set(alias, skins);
}

/** Slack's standard emoji shortcodes and skin tones; unknown workspace emoji stay readable. */
export function emojiText(text: string): string {
  return text.replace(/:([\w+-]+):(?::skin-tone-([2-6]):)?/g, (code, name: string, tone?: string) => {
    const skins = emojiSkins.get(name);
    return skins?.[tone ? Number(tone) - 1 : 0]?.native ?? code;
  });
}

/** Slack markup to plain text: links, mentions, HTML entities and standard emoji. */
export function plain(text: string) {
  return emojiText(
    text
      .replace(/<@\w+\|([^>]+)>/g, "@$1")
      .replace(/<[^>|]+\|([^>]+)>/g, "$1")
      .replace(/<([^>]+)>/g, "$1")
      .replaceAll("&amp;", "&")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">"),
  );
}

/** Parses the markdown that slack_search_public_and_private returns. */
export function parseSearch(markdown: string) {
  return markdown
    .split(/^### Result \d+ of \d+$/m)
    .slice(1)
    .flatMap((chunk) => {
      const channel = chunk.match(/^Channel: (.+?) \(ID: (\w+)\)/m);
      const from = chunk.match(/^From: (.+?) (?:<[^>]*> )?\(ID: (\w+)\)/m);
      const ts = chunk.match(/^Message_ts: ([\d.]+)/m);
      const permalink = chunk.match(/^Permalink: \[link\]\((.+?)\)$/m);
      const text = chunk.split(/^Text: *$/m)[1];
      if (!channel || !from || !ts || !permalink || text === undefined) return [];
      const url = new URL(permalink[1]);
      return [
        {
          channel: channel[1],
          channelId: channel[2],
          threadTs: url.searchParams.get("thread_ts") ?? ts[1],
          from: from[1].trim(),
          userId: from[2],
          postedAt: new Date(Number(ts[1]) * 1000),
          permalink: permalink[1],
          text: text.replace(/\n---\s*$/, "").trim(),
        },
      ];
    });
}

/** Linear ticket IDs in text, e.g. DEMO-4188. Linear validates them, so false matches are dropped later. */
export function ticketIds(text: string) {
  return [...new Set(text.match(/\b[A-Z]{2,6}-\d{1,6}\b/g))];
}

/** "Avery Brooks" → "Avery B". One-word names stay as they are. */
export function shortName(name: string) {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}` : parts[0];
}

/** Parses slack_read_thread's text: the parent message, then each reply's author and time. */
export function parseThread(messages: string) {
  const [parentPart, repliesPart = ""] = messages.split(/^=== THREAD REPLIES.*===$/m);
  const author = (block: string) => block.match(/^From: (.+?) (?:<|\()/m)?.[1].trim();
  const ts = (block: string) => block.match(/^Message TS: ([\d.]+)/m)?.[1];
  const parentText = parentPart.split(/^Message TS: [\d.]+$/m)[1];
  const replies = repliesPart.split(/^--- Reply \d+ of \d+ ---$/m).slice(1);
  const lastTs = ts(replies.at(-1) ?? parentPart);
  return {
    from: author(parentPart),
    text: parentText ? parentText.trim() : "",
    replyCount: replies.length,
    participants: [...new Set([parentPart, ...replies].map(author).filter((a): a is string => a !== undefined))],
    lastAt: lastTs ? new Date(Number(lastTs) * 1000) : undefined,
  };
}
