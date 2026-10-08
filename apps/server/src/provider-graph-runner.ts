// Executed in disposable processes by portability.test.ts, with a private profile and empty home.
import { Effect, Layer, Logger, Schema } from "effect";
import { TestClock } from "effect/testing";
import { AgentAuth } from "./services/agent-auth";
import { Dashboard } from "./services/dashboard";
import { Store, storeKey } from "./services/store";
import { Gh, GhFailure } from "./services/gh";
import { Linear, LinearFailure } from "./services/linear";
import { Mcp, McpFailure } from "./services/mcp";
import { SlackApi, SlackFailure } from "./services/slack";
import { Claude, ClaudeFailure } from "./services/claude";
import { Inbox } from "./services/inbox";
import { ServerConfig } from "./config";
import { LiveLayer } from "./live";
import { buildFeed, FeedItem } from "./lib/feed";
import { SectionName } from "@mondash/shared/contract";
import { MINE_KEY } from "./lib/linear-api";
import { profile } from "./profile";

const calls = { github: 0, linear: 0, slack: 0, notion: 0, sessions: 0 };
const counted = <A, E>(name: keyof typeof calls, effect: Effect.Effect<A, E>) =>
  Effect.sync(() => {
    calls[name]++;
  }).pipe(Effect.andThen(effect));
const adapters = Layer.mergeAll(
  Layer.succeed(
    AgentAuth,
    AgentAuth.of({
      health: counted("sessions", Effect.succeed([])),
      startClaude: Effect.die("No sign-in"),
      readClaude: () => Effect.die("No sign-in"),
      callbackClaude: () => Effect.die("No sign-in"),
    }),
  ),
  Store.layerMemory,
  ServerConfig.layer,
  TestClock.layer(),
  Logger.layer([]),
  Layer.succeed(
    Gh,
    Gh.of({ json: () => counted("github", Effect.fail(new GhFailure({ command: "synthetic", cause: "offline" }))) }),
  ),
  Layer.succeed(
    Linear,
    Linear.of({
      connected: true,
      health: Effect.succeed(undefined),
      query: () => counted("linear", Effect.fail(new LinearFailure({ cause: "offline" }))),
    }),
  ),
  Layer.succeed(
    SlackApi,
    SlackApi.of({
      get: () => counted("slack", Effect.fail(new SlackFailure({ method: "synthetic", cause: "offline" }))),
      post: () => counted("slack", Effect.fail(new SlackFailure({ method: "synthetic", cause: "offline" }))),
    }),
  ),
  Layer.succeed(
    Mcp,
    Mcp.of({
      call: (name) => counted(name, Effect.fail(new McpFailure({ server: name, cause: "offline" }))),
      cachedCall: (name) => counted(name, Effect.fail(new McpFailure({ server: name, cause: "offline" }))),
      accessToken: (name) => counted(name, Effect.succeed(undefined)),
      hasTokens: (name) => counted(name, Effect.succeed(false)),
      health: () => Effect.succeed(undefined),
      probe: (name) => counted(name, Effect.void),
      signIn: () => Effect.die("No sign-in"),
      finishSignIn: () => Effect.die("No callback"),
    }),
  ),
  Layer.succeed(
    Claude,
    Claude.of({
      reviewLaunches: counted("sessions", Effect.succeed([])),
      openSession: () => Effect.fail(new ClaudeFailure({ cause: "No actions" })),
      startReview: () => Effect.die("No actions"),
      previewReview: () => Effect.die("No actions"),
      newSession: Effect.die("No actions"),
      startSession: () => Effect.die("No actions"),
    }),
  ),
);
const services = Layer.mergeAll(Dashboard.layer, Inbox.layer).pipe(Layer.provideMerge(adapters));
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const dashboard = yield* Dashboard;
    const inbox = yield* Inbox;
    const store = yield* Store;
    yield* store.write(MINE_KEY, {
      me: { id: "self", email: "alex@example.com" },
      labelColours: {},
      issues: [
        {
          id: "APP-1",
          title: "Fix failed checkout",
          url: "https://linear.app/example/issue/APP-1",
          status: "In Progress",
          statusType: "started",
          assigneeId: "self",
          assignee: "Alex Doe",
          priority: { value: 1, name: "Urgent" },
          attachments: [],
          updatedAt: new Date().toISOString(),
          labels: [],
          projectId: null,
          description: null,
          createdAt: new Date().toISOString(),
          completedAt: null,
          canceledAt: null,
          comments: [],
          projectLinks: [],
        },
      ],
    });
    // Sources have retained data. Disabled providers must neither fetch nor appear in the aggregate.
    for (const name of ["github", "slack"] as const) {
      const item = {
        id: `${name}:1`,
        source: name,
        kind: "comment",
        title: "Work",
        url: "https://example.com",
        at: new Date(),
        reason: "reply",
        push: false,
      };
      if (name === "github") yield* store.write(storeKey("feed:github", Schema.Array(FeedItem)), [item]);
      else
        for (const kind of ["dm", "mention", "thread_reply", "saved"])
          yield* store.write(storeKey(`feed:slack:${kind}`, Schema.Array(FeedItem)), [item]);
    }
    const feed = yield* buildFeed();
    yield* dashboard.health;
    yield* dashboard.warm;
    for (let reconnect = 0; reconnect < 2; reconnect++)
      for (const name of SectionName.literals) yield* dashboard.section(name).pipe(Effect.result);
    yield* inbox.refreshAndNotify.pipe(Effect.result);
    yield* Layer.build(LiveLayer);
    for (let tick = 0; tick < 3; tick++) {
      yield* TestClock.adjust("1 minute");
      yield* Effect.yieldNow;
    }
    const issues = yield* dashboard.section("issues");
    return {
      issueIds: issues.groups.flatMap((group) => group.cards.map((card) => card.id)),
      calls,
      shown: feed.map((item) => item.source),
      enabled: profile.integrations,
    };
  }).pipe(Effect.scoped, Effect.provide(services)),
);
console.log(JSON.stringify(result));
