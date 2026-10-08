import { Option, Schema } from "effect";
import type { CalendarEvent } from "@mondash/shared/contract";
import { plain } from "./slack";

export const RichMessageFields = {
  text: Schema.optional(Schema.String),
  blocks: Schema.optional(Schema.Array(Schema.Unknown)),
  attachments: Schema.optional(Schema.Array(Schema.Unknown)),
};
const Message = Schema.Struct(RichMessageFields);
const decodeMessage = Schema.decodeUnknownOption(Message);
const TextObject = Schema.Struct({ text: Schema.String });
const Node = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.Union([Schema.String, TextObject])),
  title: Schema.optional(Schema.String),
  pretext: Schema.optional(Schema.String),
  fallback: Schema.optional(Schema.String),
  callback_id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  user_id: Schema.optional(Schema.String),
  channel_id: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  elements: Schema.optional(Schema.Array(Schema.Unknown)),
  fields: Schema.optional(Schema.Array(Schema.Unknown)),
  actions: Schema.optional(Schema.Array(Schema.Unknown)),
  blocks: Schema.optional(Schema.Array(Schema.Unknown)),
  accessory: Schema.optional(Schema.Unknown),
});
const decodeNode = Schema.decodeUnknownOption(Node);
type Link = { title: string; url: string };
export type SlackPreview = {
  title?: string;
  snippet: string;
  reason?: string;
  links: Link[];
  calendarEvent?: CalendarEvent;
};
const clean = (text: string) =>
  plain(text)
    .replace(/(^|\s)[*_~]([^\n]*?)[*_~](?=\s|$|[.,!?])/g, "$1$2")
    .trim();
const textOf = (node: typeof Node.Type) => (typeof node.text === "string" ? node.text : (node.text?.text ?? ""));
const webUrl = (value: string) => {
  try {
    const url = new URL(value.replaceAll("&amp;", "&"));
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
};

/** Plain text and actionable links from Block Kit and legacy attachments. RSVP callbacks stay in Slack. */
export function slackMessagePreview(value: unknown): SlackPreview {
  const message = decodeMessage(value);
  if (Option.isNone(message)) return { snippet: "", links: [] };
  const links = new Map<string, Link>();
  const visit = (value: unknown, depth = 0): string => {
    if (depth > 8) return "";
    const decoded = decodeNode(value);
    if (Option.isNone(decoded)) return "";
    const node = decoded.value;
    const text = textOf(node);
    if (node.type === "button") {
      const url = node.url ? webUrl(node.url) : undefined;
      if (url && text)
        links.set(url, { title: /join.*google meet/i.test(text) ? "Join Google Meet" : clean(text), url });
      return "";
    }
    if (node.type === "emoji" && node.name) return plain(`:${node.name}:`);
    if (node.type === "user" && node.user_id) return `@${node.user_id}`;
    if (node.type === "channel" && node.channel_id) return `#${node.channel_id}`;
    const children = (node.elements ?? []).map((child) => visit(child, depth + 1));
    const inline = node.type === "rich_text_section" || node.type === "rich_text_preformatted";
    const parts = [
      text || (node.type === "link" ? node.url : ""),
      children.join(inline ? "" : "\n"),
      ...(node.fields ?? []).map((field) => visit(field, depth + 1)),
      ...(node.blocks ?? []).map((block) => visit(block, depth + 1)),
    ].filter(Boolean);
    for (const action of node.actions ?? []) visit(action, depth + 1);
    if (node.accessory) visit(node.accessory, depth + 1);
    return parts.join("\n");
  };
  const blocks = (message.value.blocks ?? []).map((block) => visit(block)).filter(Boolean);
  const attachments: string[] = [];
  let title: string | undefined;
  let calendarEvent: CalendarEvent | undefined;
  for (const value of message.value.attachments ?? []) {
    const decoded = decodeNode(value);
    if (Option.isNone(decoded)) continue;
    const node = decoded.value;
    const content = visit(value);
    const eventName = node.title?.match(/<https:\/\/(?:www\.)?google\.com\/calendar\/event\?[^|>]+\|([^>]+)>/)?.[1];
    const dates = [...(node.title ?? "").matchAll(/<!date\^(\d+)\^[^|>]+\|([^>]+)>/g)];
    if (node.callback_id?.startsWith("rsvp_event_reminder:") && eventName && dates[0]) {
      const start = new Date(Number(dates[0][1]) * 1000);
      const end = dates[1] ? new Date(Number(dates[1][1]) * 1000) : undefined;
      if (Number.isFinite(start.getTime())) {
        title = clean(eventName);
        calendarEvent = {
          startsAt: start.toISOString(),
          ...(end && Number.isFinite(end.getTime()) && end > start ? { endsAt: end.toISOString() } : {}),
        };
        attachments.push(dates.map((date) => date[2]).join(" – "));
        continue;
      }
    }
    if (!title && node.title) title = clean(node.title);
    const parts = [node.pretext, node.title, content].filter(Boolean);
    attachments.push(
      parts.length ? parts.join("\n") : node.fallback === "[no preview available]" ? "" : (node.fallback ?? ""),
    );
  }
  const richText = [...blocks, ...attachments].filter(Boolean).join("\n").trim();
  const snippet = clean(calendarEvent ? (attachments[0] ?? "") : richText || message.value.text || "");
  return {
    ...(title ? { title } : {}),
    snippet,
    ...(calendarEvent ? { calendarEvent, reason: "Event reminder" } : {}),
    links: [...links.values()].slice(0, 2),
  };
}
