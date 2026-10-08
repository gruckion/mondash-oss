import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BunHttpServer } from "@effect/platform-bun";
import { Effect, Layer, Logger, Option } from "effect";
import { FetchHttpClient, HttpRouter } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { MondashApi } from "@mondash/shared/api";
import { ServerConfig } from "@/config";
import type { Kickoff } from "@/lib/claude-remote";
import { Debriefs } from "@/services/debriefs";
import { Dashboard } from "@/services/dashboard";
import { AgentAuth } from "@/services/agent-auth";
import { DesktopLinks } from "@/services/desktop-links";
import { ActionFailure, SourceFailure } from "@/services/errors";
import { Inbox } from "@/services/inbox";
import { Mcp, McpFailure } from "@/services/mcp";
import { Reviews } from "@/services/reviews";
import { Sessions } from "@/services/sessions";
import { Tickets } from "@/services/tickets";
import { Routes } from "./http";
import { SettingsManager } from "./services/settings";
import { Store } from "./services/store";

const macOpens: { id: string; target: string }[] = [];
const unused = Effect.die(new Error("not called in this test"));
const kickoffs: { request: Kickoff; prompt: string | undefined }[] = [];
const conversations: string[] = [];
const attachments: { tool: string; id: string; attachmentId: string }[] = [];
const desktopOpens: string[] = [];

const Fakes = Layer.mergeAll(
  Store.layerMemory,
  Layer.succeed(
    SettingsManager,
    SettingsManager.of({
      read: unused,
      discover: () => unused,
      apply: () => Effect.succeed({ restarting: false }),
      notionSearch: () => unused,
      notionInspect: () => unused,
    }),
  ),
  Layer.succeed(
    AgentAuth,
    AgentAuth.of({
      health: Effect.succeed([]),
      startClaude: Effect.succeed({
        id: "FF72D97B-08D1-5D66-B204-0574B0A0BAC6",
        state: "waiting",
        url: "https://claude.com/cai/oauth/authorize?state=test",
        expiresAt: "2026-10-04T14:00:00.000Z",
      }),
      readClaude: () =>
        Effect.succeed({
          id: "FF72D97B-08D1-5D66-B204-0574B0A0BAC6",
          state: "waiting",
          url: "https://claude.com/cai/oauth/authorize?state=test",
          expiresAt: "2026-10-04T14:00:00.000Z",
        }),
      callbackClaude: () =>
        Effect.fail(
          new ActionFailure({
            action: "finishClaudeSignIn",
            message: "Claude could not complete sign-in. Start sign-in again.",
            cause: new Error("secret sign-in code must stay out of the response"),
          }),
        ),
    }),
  ),
  Layer.succeed(
    DesktopLinks,
    DesktopLinks.of({
      open: (url) =>
        Effect.sync(() => {
          desktopOpens.push(url);
          return !url.includes("DEMO-404");
        }),
    }),
  ),
  Layer.succeed(
    Debriefs,
    Debriefs.of({
      history: Effect.succeed([]),
      report: () => Effect.succeed(null),
      read: Effect.succeed({ report: null, status: "idle", stage: "Ready", error: null }),
      generate: () => Effect.succeed({ report: null, status: "running", stage: "Reading Slack", error: null }),
    }),
  ),
  Layer.succeed(
    ServerConfig,
    ServerConfig.of({
      host: "127.0.0.1",
      port: 3456,
      expoGoUrl: "exp://phone.test:8081",
      ntfy: { topic: Option.none(), server: "https://ntfy.sh" },
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
  ),
  Layer.succeed(
    Dashboard,
    Dashboard.of({
      section: (name) =>
        name === "scoping"
          ? Effect.succeed({
              version: 1,
              section: "scoping",
              generatedAt: "2026-09-25T10:00:00.000Z",
              updatedAt: null,
              stale: false,
              groups: [
                {
                  id: "g",
                  title: "G",
                  collapsed: false,
                  cards: [
                    {
                      id: "c",
                      kind: "scoping",
                      title: "A card whose link breaks the contract",
                      subtitle: "",
                      status: "",
                      url: "https://[bad",
                      attention: [],
                      labels: [],
                      links: [],
                      sessions: [],
                      related: [],
                    },
                  ],
                },
              ],
            })
          : name === "sessions"
            ? Effect.succeed({
                version: 1,
                section: "sessions",
                generatedAt: "2026-09-25T10:00:00.000Z",
                updatedAt: "2026-09-25T09:59:00.000Z",
                stale: false,
                groups: [],
              })
            : Effect.fail(new SourceFailure({ source: name, cause: new Error("Linear is down") })),
      health: Effect.succeed({ version: 1, name: "Mondash", at: "2026-09-25T10:00:00.000Z", connections: [] }),
      warm: Effect.void,
    }),
  ),
  Layer.succeed(
    Inbox,
    Inbox.of({
      markRead: (id) =>
        id === "broken"
          ? Effect.fail(
              new ActionFailure({ action: "markRead", message: "Slack refused the read marker.", cause: new Error() }),
            )
          : Effect.void,
      refreshAndNotify: unused,
    }),
  ),
  Layer.succeed(
    Mcp,
    Mcp.of({
      signIn: (server) => Effect.fail(new McpFailure({ server, cause: new Error("no client") })),
      finishSignIn: (server) => Effect.fail(new McpFailure({ server, cause: new Error("bad code") })),
      call: () => unused,
      cachedCall: () => unused,
      accessToken: () => unused,
      hasTokens: () => unused,
      health: () => unused,
      probe: () => unused,
    }),
  ),
  Layer.succeed(
    Reviews,
    Reviews.of({
      start: () => unused,
      preview: (url) =>
        Effect.succeed({
          prompt: `Code review\n${url}`,
          urls: [url],
          notReady: ["https://github.com/ExampleOrg/web/pull/2"],
          reopens: false,
        }),
    }),
  ),
  Layer.succeed(
    Sessions,
    Sessions.of({
      archive: (_tool, _id, archived) => Effect.succeed({ archived }),
      search: () => Effect.succeed({ scores: [] }),
      open: () => unused,
      openOnMac: (id, target) =>
        Effect.sync(() => {
          macOpens.push({ id, target });
        }),
      openInTerminal: () => unused,
      startNew: () => unused,
      startKickoff: (request, prompt) =>
        Effect.sync(() => {
          kickoffs.push({ request, prompt });
          return { url: "https://claude.ai/code/session_Test", handoff: "session" as const };
        }),
      kickoffPrompt: (request) => Effect.succeed(`prompt for ${JSON.stringify(request)}`),
      files: () => Effect.succeed({ root: "mondash", files: [], truncated: false }),
      pullRequests: () => Effect.succeed({ prs: [], truncated: false }),
      attachment: (tool, id, attachmentId) =>
        Effect.sync(() => {
          attachments.push({ tool, id, attachmentId });
          return { name: "shot.png", mediaType: "image/png", data: "aGVsbG8=" };
        }),
      conversation: (tool, id) =>
        Effect.sync(() => {
          conversations.push(id);
          return { tool, id, title: "Fix the build", turns: [{ role: "user", text: "Fix it" }], truncated: false };
        }),
    }),
  ),
  Layer.succeed(Tickets, Tickets.of({ linkSlackThread: () => unused })),
);

// Not printed: the failures below are the point. The tests read them instead.
const logged: string[] = [];

const { handler, dispose } = HttpRouter.toWebHandler(
  Routes.pipe(
    Layer.provideMerge(Fakes),
    Layer.provideMerge(Logger.layer([Logger.make(({ message }) => logged.push(String(message)))])),
    Layer.provide(BunHttpServer.layerHttpServices),
  ),
  { disableLogger: true },
);
after(dispose);

test("phone Claude sign-in endpoints validate codes, reject cross-site requests and keep failures private", async () => {
  const post = (path: string, payload: unknown, origin?: string) =>
    handler(
      new Request(`http://mac.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", host: "mac.test", ...(origin ? { origin } : {}) },
        body: JSON.stringify(payload),
      }),
    );
  // Use the generated phone client: hand-written JSON requests hid the empty POST rejection.
  const server = Bun.serve({ port: 0, fetch: (request) => handler(request) });
  let attempt;
  try {
    attempt = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(MondashApi, { baseUrl: `http://127.0.0.1:${server.port}` });
        return yield* client.agentAuth.startClaude({ payload: {} });
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    );
  } finally {
    void server.stop(true);
  }
  assert.equal(attempt.state, "waiting");
  assert.equal((await post("/api/agent-auth/claude/start", {}, "http://other.test")).status, 403);
  const path = `/api/agent-auth/claude/${attempt.id}/callback`;
  assert.equal((await post(path, { code: "code\ncommand", state: "state" })).status, 400);
  assert.equal((await post(path, { code: "one-time-code", state: "state" }, "http://other.test")).status, 403);
  const failed = await post(path, { code: "one-time-code", state: "state" });
  assert.equal(failed.status, 422);
  assert.deepEqual(await failed.json(), {
    _tag: "ActionFailed",
    message: "Claude could not complete sign-in. Start sign-in again.",
  });
  const page = await handler(new Request("http://mac.test/auth/claude"));
  assert.equal(page.status, 302);
  assert.equal(page.headers.get("location"), attempt.url);
  assert.equal(page.headers.get("cache-control"), "no-store");
  const resumed = await handler(new Request(`http://mac.test/auth/claude?id=${attempt.id}`));
  assert.equal(resumed.status, 302);
  assert.equal(resumed.headers.get("location"), attempt.url);
});

test("session search accepts displayed candidates and rejects blank queries and invalid identities", async () => {
  const candidate = {
    id: "FF72D97B-08D1-5D66-B204-0574B0A0BAC6",
    tool: "claude",
    title: "ACH verification",
    subtitle: "Claude Code",
    preview: "Bank verification failed",
  };
  const search = (payload: unknown) =>
    handler(
      new Request("http://mac.test/api/sessions/search", {
        method: "POST",
        headers: { "content-type": "application/json", host: "mac.test", origin: "http://localhost:3456" },
        body: JSON.stringify(payload),
      }),
    );
  const response = await search({ query: "small bank deposits", candidates: [candidate] });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { scores: [] });
  assert.equal((await search({ query: "  ", candidates: [] })).status, 400);
  assert.equal((await search({ query: "bank", candidates: [{ ...candidate, id: "../../secret" }] })).status, 400);
});

const openDesktop = (url: string, origin = "http://localhost:3456") =>
  handler(
    new Request("http://mac.test/api/links/open-desktop", {
      method: "POST",
      headers: { "content-type": "application/json", host: "mac.test", origin },
      body: JSON.stringify({ url }),
    }),
  );

test("desktop opening preserves the URL and reports when the browser must fall back", async () => {
  const url = "https://linear.app/example/issue/DEMO-123?comment=c#reply";
  const opened = await openDesktop(url);
  assert.equal(opened.status, 200);
  assert.deepEqual(await opened.json(), { opened: true });
  assert.equal(desktopOpens.at(-1), url);
  assert.deepEqual(await (await openDesktop("https://linear.app/example/issue/DEMO-404")).json(), { opened: false });
});

test("desktop opening rejects unrelated hosts, non-web URLs, credentials and cross-site requests before launch", async () => {
  const before = desktopOpens.length;
  for (const url of [
    "https://linear.app.evil.test/example/issue/DEMO-1",
    "https://examplehq.slack.com.evil.test/archives/C1",
    "https://github.com/example/app/pull/1",
    "linear://example/issue/DEMO-1",
    "file:///Users/private",
    "https://user:pass@linear.app/example/issue/DEMO-1",
    "https://linear.app:8080/example/issue/DEMO-1",
    "https://[bad",
  ])
    assert.equal((await openDesktop(url)).status, 400);
  assert.equal((await openDesktop("https://linear.app/example/issue/DEMO-1", "https://evil.test")).status, 403);
  assert.equal(desktopOpens.length, before);
});

const markRead = (id: string, headers: Record<string, string> = {}) =>
  handler(
    new Request("http://mac.test/api/inbox/read", {
      method: "POST",
      headers: { "content-type": "application/json", host: "mac.test", ...headers },
      body: JSON.stringify({ id, read: true }),
    }),
  );

test("actions from the app's own origin or from the phone (no Origin) run", async () => {
  assert.equal((await markRead("C1", { origin: "http://localhost:3456" })).status, 204);
  assert.equal((await markRead("C1")).status, 204);
});

test("actions from another site are rejected before the handler runs", async () => {
  assert.equal((await markRead("C1", { origin: "https://evil.test" })).status, 403);
  assert.equal((await markRead("C1", { origin: "not a url" })).status, 403);
});

test("actions must be JSON, so a plain form post from another site cannot reach them", async () => {
  const response = await markRead("C1", { "content-type": "text/plain" });
  assert.equal(response.status, 415);
});

test("a failed action answers 422 with the message for the person, not the cause", async () => {
  const response = await markRead("broken");
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { _tag: "ActionFailed", message: "Slack refused the read marker." });
});

test("a failed source answers 503 with a message that names it", async () => {
  const response = await handler(new Request("http://mac.test/api/sections/issues"));
  assert.equal(response.status, 503);
  assert.match((await response.json()).message, /Could not refresh issues/);
});

test("activity returns readable history and names failed sections without failing the entire view", async () => {
  const response = await handler(new Request("http://mac.test/api/activity"));
  assert.equal(response.status, 200);
  const activity = await response.json();
  assert.equal(activity.version, 1);
  assert.deepEqual(activity.unavailable.sort(), ["inbox", "issues", "reviews"]);
  assert.ok(Array.isArray(activity.events));
  assert.ok(Array.isArray(activity.entities));
  assert.doesNotMatch(JSON.stringify(activity), /Linear is down/);
});

test("the legacy phone route serves health and rejects unknown sections", async () => {
  const health = await handler(new Request("http://mac.test/api/mobile/health"));
  assert.equal(health.status, 200);
  assert.equal((await health.json()).name, "Mondash");
  assert.equal((await handler(new Request("http://mac.test/api/mobile/nope"))).status, 404);
  assert.equal((await handler(new Request("http://mac.test/api/mobile/issues"))).status, 503);
});

test("old /m links redirect to the same page at the root", async () => {
  for (const [from, to] of [
    ["/m/settings", "/settings"],
    ["/m", "/"],
  ]) {
    const response = await handler(new Request(`http://mac.test${from}`));
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), to);
  }
});

test("a failed MCP sign-in shows a page that names the server; unknown servers are 404", async () => {
  const start = await handler(new Request("http://mac.test/api/auth/notion/start"));
  assert.equal(start.status, 502);
  assert.match(await start.text(), /could not finish the notion sign-in/);
  const callback = await handler(new Request("http://mac.test/api/auth/slack/callback?code=x"));
  assert.equal(callback.status, 502);
  for (const server of ["nope", "linear"])
    assert.equal((await handler(new Request(`http://mac.test/api/auth/${server}/start`))).status, 404);
});

test("the Expo Go page links to the configured Metro address", async () => {
  const response = await handler(new Request("http://mac.test/expo"));
  assert.match(await response.text(), /exp:\/\/phone\.test:8081/);
});

test("a response that breaks the contract is logged, not just a bare 400", async () => {
  logged.length = 0;
  const response = await handler(new Request("http://mac.test/api/sections/scoping"));
  assert.equal(response.status, 400);
  assert.equal(logged.filter((line) => line.includes("Request failed")).length, 1);

  logged.length = 0;
  const invalid = await handler(new Request("http://mac.test/api/sections/not-a-section"));
  assert.equal(invalid.status, 400);
  assert.equal(logged.filter((line) => line.includes("Request failed")).length, 0);
});

test("the stream sends the sections it can read, and logs the ones it cannot", async () => {
  logged.length = 0;
  const response = await handler(new Request("http://mac.test/api/stream"));
  const body = response.body;
  assert.ok(body);
  const reader = body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  assert.match(first, /^data: \{"version":"[0-9a-f]{16}","section":\{"version":1,"section":"sessions"/);
  for (const name of ["issues", "scoping", "reviews", "inbox"])
    assert.equal(logged.filter((line) => line.startsWith(`The stream could not send the ${name} section`)).length, 1);
});

const post = (path: string, body: unknown) =>
  handler(
    new Request(`http://mac.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", host: "mac.test" },
      body: JSON.stringify(body),
    }),
  );
const ticket = { ticketId: "DEMO-4214", url: "https://linear.app/example/issue/DEMO-4214/plan" };
const pr = "https://github.com/ExampleOrg/core/pull/2303";

test("a prompt preview asks for the prompt of the same kickoff the start makes", async () => {
  const preview = await post("/api/sessions/prompt", { kind: "ticket", ...ticket });
  assert.equal(preview.status, 200);
  assert.deepEqual(await preview.json(), {
    prompt: `prompt for ${JSON.stringify({ kind: "ticket", ...ticket, prs: [] })}`,
  });
  assert.deepEqual(await (await post("/api/sessions/prompt", { kind: "pr", url: pr })).json(), {
    prompt: `prompt for ${JSON.stringify({ kind: "pr", url: pr })}`,
  });
});

test("a review's prompt preview names the PRs it covers and the ones it leaves alone", async () => {
  const preview = await post("/api/sessions/prompt", { kind: "review", url: pr });
  assert.deepEqual(await preview.json(), {
    prompt: `Code review\n${pr}`,
    review: { prs: [pr], notReady: ["https://github.com/ExampleOrg/web/pull/2"], reopens: false },
  });
});

test("a start passes an edited prompt on, and refuses a blank one before it reaches Claude", async () => {
  kickoffs.length = 0;
  assert.equal((await post("/api/tickets/session", { ...ticket, prompt: " \n " })).status, 400);
  assert.equal((await post("/api/prs/session", { url: pr, prompt: "x".repeat(20_001) })).status, 400);
  assert.equal(kickoffs.length, 0);
  assert.equal((await post("/api/tickets/session", { ...ticket, prompt: "Only plan the web part." })).status, 200);
  assert.equal((await post("/api/prs/session", { url: pr })).status, 200);
  assert.deepEqual(kickoffs, [
    { request: { kind: "ticket", ...ticket, prs: [] }, prompt: "Only plan the web part." },
    { request: { kind: "pr", url: pr }, prompt: undefined },
  ]);
});

test("a session's conversation is found by its id; anything else is refused before the Mac looks", async () => {
  const id = "f92fb9f3-588b-57d4-bc6f-c38659919ee4";
  const found = await handler(new Request(`http://mac.test/api/sessions/codex/${id}/messages`));
  assert.equal(found.status, 200);
  assert.equal((await found.json()).title, "Fix the build");
  for (const path of ["codex/..%2F..%2Fetc%2Fpasswd", "codex/not-a-uuid", `cursor/${id}`])
    assert.equal((await handler(new Request(`http://mac.test/api/sessions/${path}/messages`))).status, 400);
  assert.deepEqual(conversations, [id]);
  const attachmentId = "a".repeat(64);
  const image = await handler(new Request(`http://mac.test/api/sessions/codex/${id}/attachments/${attachmentId}`));
  assert.equal(image.status, 200);
  assert.deepEqual(await image.json(), { name: "shot.png", mediaType: "image/png", data: "aGVsbG8=" });
  for (const path of [
    `codex/${id}/attachments/not-an-id`,
    `codex/not-a-uuid/attachments/${attachmentId}`,
    `cursor/${id}/attachments/${attachmentId}`,
  ])
    assert.equal((await handler(new Request(`http://mac.test/api/sessions/${path}`))).status, 400);
  assert.deepEqual(attachments, [{ tool: "codex", id, attachmentId }]);
});

test("debrief reads independently of a failed inbox and starts an async job", async () => {
  const response = await handler(new Request("http://localhost/api/inbox/debrief"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "idle");
  const started = await handler(
    new Request("http://localhost/api/inbox/debrief", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ since: "2026-09-25T00:00:00Z", until: "2026-09-30T08:00:00Z" }),
    }),
  );
  assert.equal(started.status, 200);
  assert.equal((await started.json()).status, "running");
  const invalid = await handler(
    new Request("http://localhost/api/inbox/debrief", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ since: "2026-09-30T00:00:00Z", until: "2026-09-25T08:00:00Z" }),
    }),
  );
  assert.equal(invalid.status, 400);
});

test("Mac session launch accepts only a local UUID and the two supported apps", async () => {
  macOpens.length = 0;
  const sessionId = "f92fb9f3-588b-57d4-bc6f-c38659919ee4";
  for (const target of ["terminal", "claude-desktop"]) {
    const response = await post("/api/sessions/open-mac", { sessionId, target });
    assert.equal(response.status, 204);
  }
  assert.deepEqual(macOpens, [
    { id: sessionId, target: "terminal" },
    { id: sessionId, target: "claude-desktop" },
  ]);
  assert.equal((await post("/api/sessions/open-mac", { sessionId, target: "arbitrary-command" })).status, 400);
  assert.equal((await post("/api/sessions/open-mac", { sessionId: "../../file", target: "terminal" })).status, 400);
  assert.equal(macOpens.length, 2);
});

test("setup rejects unknown fields before typed decoding or any profile write", async () => {
  const { profile } = await import("./profile");
  const response = await handler(
    new Request("http://mac.test/api/setup", {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "http://localhost:3456" },
      body: JSON.stringify({ ...profile, unexpectedSetting: "synthetic" }),
    }),
  );
  assert.equal(response.status, 422);
  assert.equal((await response.json())._tag, "ActionFailed");
});

// Native bootstrap owns the cookie. Iroh forwards only /api/, whose response headers are readable by client JS.
test("a bundled backend authorizes the native webview without leaking its capability through the API", async () => {
  const previous = process.env.MONDASH_LOCAL_CAPABILITY;
  const capability = "c".repeat(64);
  process.env.MONDASH_LOCAL_CAPABILITY = capability;
  try {
    const get = (path: string, headers: HeadersInit = {}) =>
      handler(new Request("http://mac.test" + path, { headers }));
    assert.equal((await get("/api/health")).status, 401);
    const health = await get("/api/health", { "x-mondash-capability": capability });
    assert.equal(health.status, 200);
    assert.equal(health.headers.has("set-cookie"), false);
    const bootstrap = await get("/issues", { "x-mondash-capability": capability });
    const cookie = bootstrap.headers.get("set-cookie");
    assert.ok(cookie);
    assert.ok(cookie.includes("HttpOnly"));
    assert.ok(cookie.includes("SameSite=Lax"));
    assert.equal((await get("/api/health", { cookie: cookie.split(";")[0] })).status, 200);
    assert.equal((await get("/api/health", { "x-mondash-capability": "wrong" })).status, 401);
  } finally {
    if (previous === undefined) delete process.env.MONDASH_LOCAL_CAPABILITY;
    else process.env.MONDASH_LOCAL_CAPABILITY = previous;
  }
});
