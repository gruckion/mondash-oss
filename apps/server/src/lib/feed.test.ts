import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Layer, Logger, Option, Redacted, Schema } from "effect";
import { TestClock } from "effect/testing";
import { ServerConfig, type Settings } from "@/config";
import { Gh } from "@/services/gh";
import { Inbox } from "@/services/inbox";
import { Linear } from "@/services/linear";
import { Mcp } from "@/services/mcp";
import { SlackApi, SlackFailure } from "@/services/slack";
import { Store, storeKey } from "@/services/store";
import {
  FEED_KEY,
  FeedItem,
  getFeedWithReads,
  MY_LOGIN,
  notifyNew,
  setRead,
  slackFeed,
  slackSearchFreshness,
  withSlackPreviews,
} from "./feed";
import { TRIAGE_KEY } from "./triage";

const kindOf = (query: string) =>
  query === "is:saved"
    ? "saved"
    : query.startsWith("is:thread")
      ? "thread_reply"
      : query.startsWith("to:")
        ? "dm"
        : "mention";

/** A Slack whose searches answer one message per search, stamped with `round`, and fail for the kinds in `down`. */
const fakeSlack = () => {
  const state = { round: 1, down: new Set<string>() };
  const layer = Layer.succeed(
    SlackApi,
    SlackApi.of({
      get: (method) => Effect.fail(new SlackFailure({ method, error: "not_faked" })),
      post: (method, form) => {
        const kind = kindOf(form.query);
        if (state.down.has(kind))
          return Effect.fail(new SlackFailure({ method, error: "ratelimited", retryAfter: 30 }));
        return Effect.succeed({
          ok: true,
          results: {
            messages: [
              {
                channel_id: `C${kind}`,
                message_ts: `${state.round}.000000`,
                content: kind,
                author_user_id: "U1",
                permalink: "https://x.slack.com/archives/C1/p1",
              },
            ],
          },
        });
      },
    }),
  );
  return { state, layer };
};

const testConfig = (ntfy: Settings["ntfy"]) =>
  Layer.succeed(
    ServerConfig,
    ServerConfig.of({
      host: "127.0.0.1",
      port: 0,
      expoGoUrl: "",
      ntfy,
      slackAppToken: Option.none(),
      slackClient: Option.none(),
      typesafe: Option.none(),
      terminalApp: "Terminal",
      claudeBin: Option.none(),
      newSessionDir: "/tmp",
      otlpUrl: Option.none(),
      publicUrl: Option.none(),
      linearApiKey: Option.none(),
    }),
  );

const noLinear = Linear.of({
  connected: false,
  health: Effect.succeed(undefined),
  query: () => Effect.die(new Error("not called in this test")),
});

const byKind = (items: ReadonlyArray<FeedItem>) => Object.fromEntries(items.map((item) => [item.kind, item.slack?.ts]));

test("cached empty Slack messages recover rich content once, without losing read state or other previews", async () => {
  let calls = 0;
  const empty: FeedItem = {
    id: "slack:D1:1.000000",
    source: "slack",
    kind: "dm",
    title: "Direct message",
    snippet: "",
    actor: "Google Calendar",
    slack: { channel: "D1", ts: "1.000000" },
    url: "https://example.slack.com/archives/D1/p1000000",
    at: new Date(),
    reason: "sent you a message",
    push: true,
    read: true,
  };
  const existing = { ...empty, id: "existing", snippet: "Hello 👍" };
  const failed = { ...empty, id: "failed", slack: { channel: "D2", ts: "2.000000" } };
  const api = Layer.succeed(
    SlackApi,
    SlackApi.of({
      post: (method) => Effect.fail(new SlackFailure({ method, error: "not_expected" })),
      get: (method, params) =>
        Effect.gen(function* () {
          calls++;
          if (params.channel === "D2") return yield* new SlackFailure({ method, error: "channel_not_found" });
          assert.equal(method, "conversations.history");
          assert.equal(params.oldest, "1.000000");
          assert.equal(params.latest, "1.000000");
          return {
            ok: true,
            messages: [
              {
                ts: "1.000000",
                text: "",
                attachments: [
                  {
                    title:
                      "<!date^1790865000^{time}|3:30 PM> <https://www.google.com/calendar/event?eid=example|Daily Check-in>",
                    callback_id: "rsvp_event_reminder:15",
                  },
                  {
                    actions: [
                      { type: "button", text: "Join Google Meet Meeting", url: "https://meet.google.com/abc-defg-hij" },
                    ],
                  },
                ],
              },
            ],
          };
        }),
    }),
  );
  const [first, again] = await Effect.gen(function* () {
    const first = yield* withSlackPreviews([empty, existing, failed]);
    const again = yield* withSlackPreviews([empty]);
    return [first, again];
  }).pipe(Effect.scoped, Effect.provide([Store.layerMemory, api, Logger.layer([])]), Effect.runPromise);
  assert.equal(first[0].title, "Daily Check-in");
  assert.equal(first[0].read, true);
  assert.equal(first[0].reason, "Event reminder");
  assert.equal(first[0].calendarEvent?.startsAt, "2026-10-01T14:30:00.000Z");
  assert.equal(first[0].links?.[0].title, "Join Google Meet");
  assert.deepEqual(first[1], existing);
  assert.deepEqual(first[2], failed);
  assert.deepEqual(again[0], first[0]);
  assert.equal(calls, 2, "successful rich messages stay cached; regular previews need no lookup");
});

test("a failed Slack search keeps its last result and leaves the searches that worked", async () => {
  const slack = fakeSlack();
  const [first, later] = await Effect.gen(function* () {
    slack.state.down.add("mention");
    const first = yield* slackFeed;

    slack.state.down.clear();
    yield* TestClock.adjust("61 minutes");
    yield* slackFeed;
    yield* Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, { discard: true });

    slack.state.round = 2;
    slack.state.down.add("dm");
    yield* TestClock.adjust("61 minutes");
    yield* slackFeed;
    yield* Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, { discard: true });
    return [first, yield* slackFeed];
  }).pipe(
    Effect.scoped,
    Effect.provide([Store.layerMemory, slack.layer, TestClock.layer(), Logger.layer([])]),
    Effect.runPromise,
  );

  assert.deepEqual(byKind(first), { dm: "1.000000", thread_reply: "1.000000", saved: "1.000000" });
  assert.deepEqual(byKind(later), {
    dm: "1.000000",
    mention: "2.000000",
    thread_reply: "2.000000",
    saved: "2.000000",
  });
});

test("notifyNew marks an item seen only once its alert went out", async () => {
  const failing = new Set(["a said"]);
  const sent: string[] = [];
  const ntfy = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body: unknown = await request.json();
      const title = typeof body === "object" && body !== null && "title" in body ? String(body.title) : "";
      sent.push(title);
      // 400: a refusal that is not retried, so the next run is what sends it again.
      return new Response(null, { status: failing.has(title) ? 400 : 200 });
    },
  });
  const config = testConfig({ topic: Option.some(Redacted.make("test")), server: ntfy.url.href });
  const item = (id: string, reason: string): FeedItem => ({
    id,
    source: "github",
    kind: "comment",
    title: id,
    url: "https://example.com",
    at: new Date(),
    reason,
    push: true,
  });
  const items = [item("a", "a said"), item("b", "b said")];

  try {
    await Effect.gen(function* () {
      yield* notifyNew([]);
      yield* notifyNew(items);
      failing.clear();
      yield* notifyNew(items);
    }).pipe(Effect.scoped, Effect.provide([Store.layerMemory, config, Logger.layer([])]), Effect.runPromise);
  } finally {
    await ntfy.stop(true);
  }

  // "a said" failed the first time, so it is sent again; "b said" went out once.
  assert.deepEqual(sent, ["a said", "b said", "a said"]);
});

test("marking a DM read updates its entry in the Slack read map instead of reading every marker again", async () => {
  const unused = Effect.die(new Error("not called in this test"));
  const lastRead: Record<string, string> = { D1: "99.000000", C1: "60.000000" };
  const gets: string[] = [];
  const marks: string[] = [];
  const slack = Layer.succeed(
    SlackApi,
    SlackApi.of({
      get: (method, params) =>
        Effect.sync(() => {
          gets.push(params.channel);
          return { ok: true, channel: { last_read: lastRead[params.channel] } };
        }),
      post: (_method, form) =>
        Effect.sync(() => {
          marks.push(`${form.channel}:${form.ts}`);
          lastRead[form.channel] = form.ts;
          return { ok: true };
        }),
    }),
  );
  const mcp = Mcp.of({
    signIn: () => unused,
    finishSignIn: () => unused,
    call: () => unused,
    cachedCall: () => unused,
    accessToken: () => Effect.succeed("token"),
    hasTokens: () => unused,
    health: () => unused,
    probe: () => unused,
  });
  const item = (id: string, kind: string, channel: string, ts: string): FeedItem => ({
    id,
    source: "slack",
    kind,
    title: id,
    url: "https://x.slack.com/archives/C1/p1",
    at: new Date(),
    reason: "said",
    push: true,
    slack: { channel, ts },
  });

  const [first, after] = await Effect.gen(function* () {
    const store = yield* Store;
    yield* store.write(FEED_KEY, [item("dm", "dm", "D1", "100.000000"), item("mention", "mention", "C1", "50.000000")]);
    const first = yield* getFeedWithReads();
    yield* setRead("dm", true);
    return [first, yield* getFeedWithReads()];
  }).pipe(
    Effect.scoped,
    Effect.provide([
      Store.layerMemory,
      slack,
      testConfig({ topic: Option.none(), server: "https://ntfy.test" }),
      Logger.layer([]),
    ]),
    Effect.provideService(Mcp, mcp),
    Effect.provideService(Linear, noLinear),
    Effect.provideService(Gh, Gh.of({ json: () => unused })),
    Effect.runPromise,
  );

  const reads = (items: ReadonlyArray<FeedItem>) => Object.fromEntries(items.map((i) => [i.id, i.read]));
  assert.deepEqual(reads(first), { dm: false, mention: true });
  assert.deepEqual(reads(after), { dm: true, mention: true });
  assert.deepEqual(marks, ["D1:100.000000"]);
  // Two markers for the first load and one check before the mark; none again for the second load.
  assert.deepEqual(gets, ["D1", "C1", "D1"]);
});

test("after the first check, only conversations with an unread item are checked again", async () => {
  const unused = Effect.die(new Error("not called in this test"));
  const gets: string[] = [];
  const slack = Layer.succeed(
    SlackApi,
    SlackApi.of({
      get: (_method, params) =>
        Effect.sync(() => {
          gets.push(params.channel);
          return { ok: true, channel: { last_read: params.channel === "C1" ? "60.000000" : "99.000000" } };
        }),
      post: () => unused,
    }),
  );
  const mcp = Mcp.of({
    signIn: () => unused,
    finishSignIn: () => unused,
    call: () => unused,
    cachedCall: () => unused,
    accessToken: () => Effect.succeed("token"),
    hasTokens: () => unused,
    health: () => unused,
    probe: () => unused,
  });
  const item = (id: string, channel: string, ts: string): FeedItem => ({
    id,
    source: "slack",
    kind: "dm",
    title: id,
    url: "https://x.slack.com/archives/C1/p1",
    at: new Date(0),
    reason: "said",
    push: true,
    slack: { channel, ts },
  });

  await Effect.gen(function* () {
    const store = yield* Store;
    yield* store.write(FEED_KEY, [item("unread", "D1", "100.000000"), item("read", "C1", "50.000000")]);
    yield* getFeedWithReads();
    yield* TestClock.adjust("2 minutes");
    yield* getFeedWithReads();
    yield* Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, { discard: true });
  }).pipe(
    Effect.scoped,
    Effect.provide([
      Store.layerMemory,
      slack,
      testConfig({ topic: Option.none(), server: "https://ntfy.test" }),
      TestClock.layer(),
      Logger.layer([]),
    ]),
    Effect.provideService(Mcp, mcp),
    Effect.provideService(Linear, noLinear),
    Effect.provideService(Gh, Gh.of({ json: () => unused })),
    Effect.runPromise,
  );

  assert.deepEqual(gets, ["D1", "C1", "D1"]);
});

test("the Inbox refreshes notifications, labels approvals by PR ownership, and reads Triage as stored", async () => {
  const slack = fakeSlack();
  // A ten-digit ts, so the saved item's permalink form matches the stored verdict.
  slack.state.round = 1790000000;
  let round = 1;
  const linear = Linear.of({
    connected: true,
    health: Effect.succeed(undefined),
    query: (_text, _variables, schema) =>
      Schema.decodeUnknownEffect(schema)({
        notifications: {
          nodes: [
            {
              id: `n${round}`,
              type: "issueNewComment",
              title: "Ticket",
              subtitle: "Morgan commented: hi",
              url: "https://linear.app/example/issue/DEMO-1",
              category: "comments",
              createdAt: "1970-01-01T00:00:00.000Z",
              readAt: null,
              groupingKey: `g${round}`,
            },
          ],
        },
      }).pipe(Effect.orDie),
  });
  let hydrationCalls = 0;
  const approvals = [
    { number: 2, author: { login: MY_LOGIN.toUpperCase() }, reason: "review_requested", expected: "approved your PR" },
    { number: 3, author: { login: "someone-else" }, reason: "author", expected: "approved PR" },
    { number: 4, author: null, reason: "review_requested", expected: "approved PR" },
  ];
  const gh = Gh.of({
    json: (args, schema) => {
      if (String(args[1]).startsWith("notifications"))
        return Schema.decodeUnknownEffect(schema)([
          {
            id: "1",
            unread: round === 1,
            reason: "author",
            updated_at: round < 3 ? "1970-01-01T00:00:00Z" : "1970-01-01T00:01:00Z",
            subject: {
              title: "A PR",
              type: "PullRequest",
              url: "https://api.github.com/repos/ExampleOrg/core/pulls/1",
            },
            repository: { full_name: "ExampleOrg/core", owner: { login: "ExampleOrg" } },
          },
          ...approvals.map(({ number, reason }) => ({
            id: String(number),
            unread: round === 1,
            reason,
            updated_at: "1970-01-01T00:00:00Z",
            subject: {
              title: `Approved PR ${number}`,
              type: "PullRequest",
              url: `https://api.github.com/repos/ExampleOrg/core/pulls/${number}`,
            },
            repository: { full_name: "ExampleOrg/core", owner: { login: "ExampleOrg" } },
          })),
        ]).pipe(Effect.orDie);
      hydrationCalls++;
      return Schema.decodeUnknownEffect(schema)({
        data: {
          p0: {
            pullRequest: {
              url: "https://github.com/ExampleOrg/core/pull/1",
              author: { login: MY_LOGIN },
              timelineItems: {
                nodes: [
                  {
                    __typename: "IssueComment",
                    createdAt: `1970-01-01T00:0${round}:00Z`,
                    bodyText: `comment ${round}`,
                    author: { login: "morgan", __typename: "User" },
                  },
                ],
              },
            },
          },
          ...Object.fromEntries(
            approvals.map(({ number, author }, index) => [
              `p${index + 1}`,
              {
                pullRequest: {
                  url: `https://github.com/ExampleOrg/core/pull/${number}`,
                  author,
                  timelineItems: {
                    nodes: [
                      {
                        __typename: "PullRequestReview",
                        createdAt: "1970-01-01T00:00:00Z",
                        state: "APPROVED",
                        author: { login: "reviewer", __typename: "User" },
                      },
                    ],
                  },
                },
              },
            ]),
          ),
        },
      }).pipe(Effect.orDie);
    },
  });
  // Any MCP call (the Roadmap's or Triage's own build) fails the test.
  const unused = Effect.die(new Error("the Inbox build reads Roadmap and Triage from the store"));
  const mcp = Mcp.of({
    signIn: () => unused,
    finishSignIn: () => unused,
    call: () => unused,
    cachedCall: () => unused,
    accessToken: () => Effect.succeed(undefined),
    hasTokens: () => unused,
    health: () => unused,
    probe: () => unused,
  });
  const [first, second, third] = await Effect.gen(function* () {
    const store = yield* Store;
    const inbox = yield* Inbox;
    yield* store.write(TRIAGE_KEY, [
      {
        permalink: "https://x.slack.com/archives/Csaved/p1790000000000000",
        tickets: [],
        show: false,
        reason: "Jev: 10% chance it still needs you",
      },
    ]);
    yield* inbox.refreshAndNotify;
    const first = (yield* store.read(FEED_KEY))?.value;
    round = 2;
    yield* inbox.refreshAndNotify;
    const second = (yield* store.read(FEED_KEY))?.value;
    round = 3;
    yield* inbox.refreshAndNotify;
    return [first, second, (yield* store.read(FEED_KEY))?.value];
  }).pipe(
    Effect.provide(Inbox.layer),
    Effect.provideService(Linear, linear),
    Effect.provideService(Gh, gh),
    Effect.provideService(Mcp, mcp),
    Effect.scoped,
    Effect.provide([
      Store.layerMemory,
      slack.layer,
      testConfig({ topic: Option.none(), server: "" }),
      TestClock.layer(),
      Logger.layer([]),
    ]),
    Effect.runPromise,
  );
  const linearIds = (items: ReadonlyArray<FeedItem> | undefined) =>
    (items ?? []).filter((item) => item.source === "linear").map((item) => item.id);
  assert.deepEqual(linearIds(first), ["linear:n1"]);
  assert.deepEqual(linearIds(second), ["linear:n2"]);
  assert.equal(second?.find((item) => item.kind === "saved")?.done, "Jev: 10% chance it still needs you");
  assert.equal(hydrationCalls, 2, "unchanged PR notification timelines are reused, changed ones are fetched");
  assert.equal(second?.find((item) => item.source === "github")?.snippet, "comment 1");
  assert.equal(
    second?.find((item) => item.source === "github")?.read,
    true,
    "read state comes from the current REST notification",
  );
  assert.equal(third?.find((item) => item.source === "github")?.snippet, "comment 3");
  for (const items of [first, second, third])
    for (const { number, expected } of approvals)
      assert.equal(items?.find((item) => item.title.startsWith(`core#${number} `))?.reason, expected);
});

test("Slack freshness follows each search cadence and requires every search to complete", async () => {
  const result = await Effect.gen(function* () {
    const store = yield* Store;
    const blank = yield* slackSearchFreshness;
    yield* store.write(storeKey("feed:slack:saved", Schema.Array(FeedItem)), []);
    yield* TestClock.adjust("45 minutes");
    for (const kind of ["dm", "mention", "thread_reply"])
      yield* store.write(storeKey(`feed:slack:${kind}`, Schema.Array(FeedItem)), []);
    const normal = yield* slackSearchFreshness;
    yield* TestClock.adjust("45 minutes");
    for (const kind of ["dm", "thread_reply"])
      yield* store.write(storeKey(`feed:slack:${kind}`, Schema.Array(FeedItem)), []);
    const missedMention = yield* slackSearchFreshness;
    yield* store.write(storeKey("feed:slack:mention", Schema.Array(FeedItem)), []);
    const savedNext = yield* slackSearchFreshness;
    yield* store.forget("feed:slack:dm");
    const incomplete = yield* slackSearchFreshness;
    return { blank, normal, missedMention, savedNext, incomplete };
  }).pipe(Effect.scoped, Effect.provide([Store.layerMemory, TestClock.layer()]), Effect.runPromise);
  assert.deepEqual(result.blank, { lastSyncedAt: null, refreshDueAt: null });
  assert.equal(result.normal.lastSyncedAt, new Date(0).toISOString());
  assert.equal(result.normal.refreshDueAt, new Date(85 * 60_000).toISOString());
  assert.equal(result.missedMention.refreshDueAt, new Date(85 * 60_000).toISOString());
  assert.equal(result.savedNext.refreshDueAt, new Date(120 * 60_000).toISOString());
  assert.equal(result.incomplete.refreshDueAt, null);
});
