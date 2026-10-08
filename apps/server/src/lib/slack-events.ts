import { Option, Schema } from "effect";
import { RichMessageFields } from "./slack-message";

/** A message event from Slack's Socket Mode envelope (user events `message.im`, `.mpim`, `.channels`, `.groups`). */
const MessageEvent = Schema.Struct({
  type: Schema.Literal("message"),
  channel: Schema.String,
  channel_type: Schema.optional(Schema.String),
  user: Schema.optional(Schema.String),
  ...RichMessageFields,
  ts: Schema.String,
  thread_ts: Schema.optional(Schema.String),
  subtype: Schema.optional(Schema.String),
});
export type MessageEvent = typeof MessageEvent.Type;

const decodeEnvelope = Schema.decodeOption(
  Schema.fromJsonString(Schema.Struct({ payload: Schema.Struct({ event: MessageEvent }) })),
);

// Edits, deletions, joins and bot posts are not new messages to you.
const NEW_MESSAGE = new Set(["file_share", "thread_broadcast"]);

/** The new message in a socket envelope, if it carries one. */
export const messageEvent = (text: string): MessageEvent | undefined => {
  const envelope = decodeEnvelope(text);
  if (Option.isNone(envelope)) return undefined;
  const { event } = envelope.value.payload;
  return event.user && (!event.subtype || NEW_MESSAGE.has(event.subtype)) ? event : undefined;
};

/**
 * Which Inbox list a message from someone else belongs in, as the searches would file it: a DM, a mention of you, or
 * a reply in a thread you took part in. Undefined for everything else.
 */
export const inboxKind = (
  event: MessageEvent,
  me: string,
  myThreads: ReadonlySet<string>,
): "dm" | "mention" | "thread_reply" | undefined => {
  if (event.user === me) return undefined;
  if (event.channel_type === "im" || event.channel_type === "mpim") return "dm";
  if (event.text?.includes(`<@${me}>`)) return "mention";
  if (event.thread_ts && event.thread_ts !== event.ts && myThreads.has(event.thread_ts)) return "thread_reply";
  return undefined;
};

/** The link Slack gives the message: a reply links into its thread. */
export const permalink = (workspace: string, event: MessageEvent) => {
  const base = `${workspace.replace(/\/$/, "")}/archives/${event.channel}/p${event.ts.replace(".", "")}`;
  return event.thread_ts && event.thread_ts !== event.ts
    ? `${base}?thread_ts=${event.thread_ts}&cid=${event.channel}`
    : base;
};
