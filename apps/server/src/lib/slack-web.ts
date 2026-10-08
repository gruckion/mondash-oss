import { enabled } from "../profile";
import { Duration, Effect, Option, Schema } from "effect";
import type { DmMessage } from "@/lib/dm-context";
import { SlackApi } from "@/services/slack";
import { Store, storeKey } from "@/services/store";
import { RichMessageFields } from "./slack-message";

// Slack Web API calls for data the Slack MCP tools do not return. They use the same OAuth token.

// Names and avatars rarely change, so cache them for a day.
const DAY = Duration.days(1);

const Ok = Schema.StructWithRest(Schema.Struct({ ok: Schema.Literal(true) }), [
  Schema.Record(Schema.String, Schema.Unknown),
]);
const decodeOk = Schema.decodeUnknownEffect(Ok);

/** A Slack Web API call. Only successful responses reach the store: a failed call leaves the old value. */
const slackApi = (method: string, params: Record<string, string>, fresh: Duration.Input = DAY) =>
  Effect.gen(function* () {
    if (!enabled("slack")) return undefined;
    const store = yield* Store;
    const slack = yield* SlackApi;
    const key = storeKey(`slack:${method}:${JSON.stringify(params)}`, Ok);
    return yield* store.cached(key, fresh, slack.get(method, params).pipe(Effect.flatMap(decodeOk)));
  }).pipe(Effect.orElseSucceed(() => undefined));

const SlackUser = Schema.Struct({
  ok: Schema.Literal(true),
  user: Schema.Struct({
    profile: Schema.Struct({ image_48: Schema.String, real_name: Schema.optional(Schema.String) }),
  }),
});
const decodeSlackUser = Schema.decodeUnknownOption(SlackUser);
const SlackChannel = Schema.Struct({ ok: Schema.Literal(true), channel: Schema.Struct({ name: Schema.String }) });
const decodeSlackChannel = Schema.decodeUnknownOption(SlackChannel);

/** Avatar URL: the MCP profile tool has no image. Undefined if the lookup fails. */
export const avatar = Effect.fn("slack-web.avatar")(function* (userId: string) {
  const parsed = decodeSlackUser(yield* slackApi("users.info", { user: userId }));
  return Option.isSome(parsed) ? parsed.value.user.profile.image_48 : undefined;
});

/** A person's name, from the same cached lookup as their avatar. Undefined if the lookup fails. */
export const userName = Effect.fn("slack-web.userName")(function* (userId: string) {
  const parsed = decodeSlackUser(yield* slackApi("users.info", { user: userId }));
  return Option.isSome(parsed) ? parsed.value.user.profile.real_name : undefined;
});

/** Channel name without "#". Undefined if the lookup fails. */
export const channelName = Effect.fn("slack-web.channelName")(function* (channelId: string) {
  const parsed = decodeSlackChannel(yield* slackApi("conversations.info", { channel: channelId }));
  return Option.isSome(parsed) ? parsed.value.channel.name : undefined;
});

const AuthTest = Schema.Struct({
  ok: Schema.Literal(true),
  user_id: Schema.String,
  team_id: Schema.String,
  url: Schema.String,
});
const decodeAuthTest = Schema.decodeUnknownOption(AuthTest);

/** Your Slack user ID, to spot @mentions of you. Undefined if the lookup fails. */
export const mySlackId = Effect.fn("slack-web.mySlackId")(function* () {
  const parsed = decodeAuthTest(yield* slackApi("auth.test", {}));
  return Option.isSome(parsed) ? parsed.value.user_id : undefined;
});

/** Your Slack workspace (team) ID: app links need it. Undefined if the lookup fails. */
export const mySlackTeam = Effect.fn("slack-web.mySlackTeam")(function* () {
  const parsed = decodeAuthTest(yield* slackApi("auth.test", {}));
  return Option.isSome(parsed) ? parsed.value.team_id : undefined;
});

const DMs = Schema.Struct({
  ok: Schema.Literal(true),
  channels: Schema.Array(Schema.Struct({ id: Schema.String, user: Schema.String })),
});
const decodeDMs = Schema.decodeUnknownOption(DMs);
const History = Schema.Struct({
  ok: Schema.Literal(true),
  messages: Schema.Array(
    Schema.StructWithRest(
      Schema.Struct({ user: Schema.optional(Schema.String), text: Schema.optional(Schema.String), ts: Schema.String }),
      [Schema.Record(Schema.String, Schema.Unknown)],
    ),
  ),
});
const decodeHistory = Schema.decodeUnknownOption(History);

const RichHistory = Schema.Struct({
  ok: Schema.Literal(true),
  messages: Schema.Array(Schema.Struct({ ts: Schema.String, ...RichMessageFields })),
});
const decodeRichHistory = Schema.decodeUnknownOption(RichHistory);

/** Recover rich content for old Inbox entries whose empty text field lost their attachments. */
export const slackMessage = Effect.fn("slack-web.slackMessage")(function* (
  channel: string,
  ts: string,
  threadTs?: string,
) {
  const parsed = decodeRichHistory(
    yield* slackApi(
      threadTs ? "conversations.replies" : "conversations.history",
      { channel, ...(threadTs ? { ts: threadTs } : {}), oldest: ts, latest: ts, inclusive: "true", limit: "1" },
      Duration.days(14),
    ),
  );
  return Option.isSome(parsed) ? parsed.value.messages.find((message) => message.ts === ts) : undefined;
});

/** Your workspace URL ("https://examplehq.slack.com/"), for building message links. Undefined if the lookup fails. */
export const myWorkspace = Effect.fn("slack-web.myWorkspace")(function* () {
  const parsed = decodeAuthTest(yield* slackApi("auth.test", {}));
  return Option.isSome(parsed) ? parsed.value.url : undefined;
});

/** Your direct message channel with each person, by Slack user ID. */
export const dmChannels = Effect.fn("slack-web.dmChannels")(function* () {
  const parsed = decodeDMs(yield* slackApi("conversations.list", { types: "im", limit: "200" }));
  return new Map(Option.isSome(parsed) ? parsed.value.channels.map((c) => [c.user, c.id]) : []);
});

/** A DM's messages since `oldest` (seconds), oldest first. Cached briefly: a new message should show up soon. */
export const dmMessages = Effect.fn("slack-web.dmMessages")(function* (channel: string, oldest: number) {
  const parsed = decodeHistory(
    yield* slackApi(
      "conversations.history",
      { channel, oldest: String(Math.floor(oldest)), limit: "200" },
      Duration.minutes(5),
    ),
  );
  if (Option.isNone(parsed)) return [];
  return parsed.value.messages
    .flatMap((m): DmMessage[] => (m.user && m.text ? [{ user: m.user, text: m.text, ts: m.ts }] : []))
    .toReversed();
});
