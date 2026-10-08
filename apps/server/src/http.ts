import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { profile, profilePath, readProfile, decodeProfile, enabled } from "./profile";
import { privateUpdate } from "./private-files";
import { checkNotionSetup } from "./notion-setup";
import { coverage } from "./coverage";
import { origins } from "./lib/mcp";
import { Cause, Effect, ErrorReporter, Layer, Option, Schema, Stream } from "effect";
import { HttpMiddleware, HttpRouter, HttpServerRequest, HttpServerResponse, HttpStaticServer } from "effect/http";
import { HttpApiBuilder, HttpApiError } from "effect/http-api";
import { ActionFailed, MondashApi, type PromptRequest, SourceUnavailable } from "@mondash/shared/api";
import { SectionName } from "@mondash/shared/contract";
import { ServerConfig } from "@/config";
import type { Kickoff } from "@/lib/claude-remote";
import { isServerName } from "@/lib/mcp";
import { sectionEvent, sentFrom } from "@/lib/section-stream";
import { Debriefs } from "@/services/debriefs";
import { Dashboard } from "@/services/dashboard";
import { DesktopLinks } from "@/services/desktop-links";
import type { ActionFailure, SourceFailure } from "@/services/errors";
import { Inbox } from "@/services/inbox";
import { Mcp } from "@/services/mcp";
import { Reviews } from "@/services/reviews";
import { Sessions } from "@/services/sessions";
import { AgentAuth } from "@/services/agent-auth";
import { Tickets } from "@/services/tickets";
import { SettingsManager } from "./services/settings";
import { readActivity } from "./lib/activity";
import { Store } from "./services/store";

/** The web build of the app, served from the root; `bun run build` makes it. */
const WEB_BUILD = process.env.MONDASH_WEB_ROOT ?? fileURLToPath(new URL("../../app/dist", import.meta.url));

const isSection = Schema.is(SectionName);

/** Logs what really happened, then answers with the words meant for the person. */
const toActionFailed = (failure: ActionFailure) =>
  Effect.logError(`${failure.action} failed`, failure.cause).pipe(
    Effect.andThen(Effect.fail(new ActionFailed({ message: failure.message }))),
  );

const toSourceUnavailable = (failure: SourceFailure) =>
  Effect.logError(`Could not build ${failure.source}`, failure.cause).pipe(
    Effect.andThen(
      Effect.fail(
        new SourceUnavailable({
          message:
            failure.source === "health"
              ? "Could not read the connection state on your Mac."
              : `Could not refresh ${failure.source}. Check the connection on your Mac.`,
        }),
      ),
    ),
  );

/** A ticket's PRs are optional in the request; a start without them plans the whole ticket. */
const kickoffOf = (request: typeof PromptRequest.Type & { kind: "ticket" | "pr" }): Kickoff =>
  request.kind === "ticket" ? { ...request, prs: request.prs ?? [] } : request;

const DashboardHandlers = HttpApiBuilder.group(
  MondashApi,
  "dashboard",
  Effect.fn(function* (handlers) {
    const dashboard = yield* Dashboard;
    return handlers
      .handle("health", () => dashboard.health.pipe(Effect.catch(toSourceUnavailable)))
      .handle("section", ({ params }) => dashboard.section(params.section).pipe(Effect.catch(toSourceUnavailable)));
  }),
);

const ActivityHandlers = HttpApiBuilder.group(
  MondashApi,
  "activity",
  Effect.fn(function* (handlers) {
    const dashboard = yield* Dashboard;
    const store = yield* Store;
    return handlers.handle("read", () =>
      Effect.gen(function* () {
        const unavailable = (yield* Effect.forEach(
          SectionName.literals,
          (name) =>
            dashboard.section(name).pipe(
              Effect.as(undefined),
              Effect.catch(() => Effect.succeed(name)),
            ),
          { concurrency: "unbounded" },
        )).filter((name) => name !== undefined);
        const activity = yield* readActivity().pipe(
          Effect.provideService(Store, store),
          Effect.mapError(() => new SourceUnavailable({ message: "Could not read activity history on your Mac." })),
        );
        return { ...activity, unavailable };
      }),
    );
  }),
);

const AgentAuthHandlers = HttpApiBuilder.group(
  MondashApi,
  "agentAuth",
  Effect.fn(function* (handlers) {
    const auth = yield* AgentAuth;
    return handlers
      .handle("startClaude", () => auth.startClaude.pipe(Effect.catch(toActionFailed)))
      .handle("claudeStatus", ({ params }) => auth.readClaude(params.id).pipe(Effect.catch(toActionFailed)))
      .handle("callbackClaude", ({ params, payload }) =>
        auth.callbackClaude(params.id, payload.code, payload.state).pipe(Effect.catch(toActionFailed)),
      );
  }),
);

const ClaudeSignInRedirect = HttpRouter.add(
  "GET",
  "/auth/claude",
  Effect.gen(function* () {
    const auth = yield* AgentAuth;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const id = new URL(request.url, "http://localhost").searchParams.get("id");
    const attempt = yield* id ? auth.readClaude(id) : auth.startClaude;
    if (attempt.state === "connected") return HttpServerResponse.redirect("/settings");
    if (attempt.state !== "waiting" || !attempt.url)
      return HttpServerResponse.text("Claude sign-in is not available. Try again from Settings.", { status: 409 });
    return HttpServerResponse.redirect(attempt.url, {
      headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
    });
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(
        HttpServerResponse.text("Could not start Claude sign-in. Try again from Settings.", { status: 502 }),
      ),
    ),
  ),
);

const SessionHandlers = HttpApiBuilder.group(
  MondashApi,
  "sessions",
  Effect.fn(function* (handlers) {
    const sessions = yield* Sessions;
    return handlers
      .handle("archive", ({ payload }) =>
        sessions.archive(payload.tool, payload.sessionId, payload.archived).pipe(Effect.catch(toActionFailed)),
      )
      .handle("search", ({ payload }) => sessions.search(payload).pipe(Effect.catch(toActionFailed)))
      .handle("attachment", ({ params }) =>
        sessions.attachment(params.tool, params.id, params.attachmentId).pipe(Effect.catch(toActionFailed)),
      )
      .handle("files", ({ params }) => sessions.files(params.tool, params.id).pipe(Effect.catch(toActionFailed)))
      .handle("pullRequests", ({ params }) =>
        sessions.pullRequests(params.tool, params.id).pipe(Effect.catch(toActionFailed)),
      )
      .handle("conversation", ({ params }) =>
        sessions.conversation(params.tool, params.id).pipe(Effect.catch(toActionFailed)),
      );
  }),
);

const ActionHandlers = HttpApiBuilder.group(
  MondashApi,
  "actions",
  Effect.fn(function* (handlers) {
    const inbox = yield* Inbox;
    const sessions = yield* Sessions;
    const reviews = yield* Reviews;
    const tickets = yield* Tickets;
    const desktopLinks = yield* DesktopLinks;
    return handlers
      .handle("openDesktopLink", ({ payload }) =>
        desktopLinks.open(payload.url).pipe(Effect.map((opened) => ({ opened }))),
      )
      .handle("markRead", ({ payload }) => inbox.markRead(payload.id, payload.read).pipe(Effect.catch(toActionFailed)))
      .handle("linkSlackThread", ({ payload }) => tickets.linkSlackThread(payload).pipe(Effect.catch(toActionFailed)))
      .handle("openSession", ({ payload }) =>
        sessions.open(payload.tool, payload.sessionId).pipe(Effect.catch(toActionFailed)),
      )
      .handle("newSession", ({ payload }) => sessions.startNew(payload.tool).pipe(Effect.catch(toActionFailed)))
      .handle("ticketSession", ({ payload: { prompt, ...ticket } }) =>
        sessions.startKickoff(kickoffOf({ kind: "ticket", ...ticket }), prompt).pipe(Effect.catch(toActionFailed)),
      )
      .handle("prSession", ({ payload: { url, prompt } }) =>
        sessions.startKickoff({ kind: "pr", url }, prompt).pipe(Effect.catch(toActionFailed)),
      )
      .handle("openOnMac", ({ payload }) =>
        sessions.openOnMac(payload.sessionId, payload.target).pipe(Effect.catch(toActionFailed)),
      )
      .handle("openInTerminal", ({ payload }) =>
        sessions.openInTerminal(payload.sessionId).pipe(Effect.catch(toActionFailed)),
      )
      .handle("startReview", ({ payload }) =>
        reviews.start(payload.url, payload.startNew === true, payload.prompt).pipe(Effect.catch(toActionFailed)),
      )
      .handle("promptPreview", ({ payload }) =>
        (payload.kind === "review"
          ? reviews.preview(payload.url, payload.startNew === true).pipe(
              Effect.map(({ prompt, urls, notReady, reopens }) => ({
                prompt,
                review: { prs: urls, notReady, reopens },
              })),
            )
          : sessions.kickoffPrompt(kickoffOf(payload)).pipe(Effect.map((prompt) => ({ prompt })))
        ).pipe(Effect.catch(toActionFailed)),
      );
  }),
);

const DebriefHandlers = HttpApiBuilder.group(
  MondashApi,
  "debrief",
  Effect.fn(function* (handlers) {
    const debriefs = yield* Debriefs;
    return handlers
      .handle("read", () => debriefs.read.pipe(Effect.catch(toActionFailed)))
      .handle("history", () => debriefs.history.pipe(Effect.catch(toActionFailed)))
      .handle("report", ({ params }) => debriefs.report(params.id).pipe(Effect.catch(toActionFailed)))
      .handle("generate", ({ payload }) => debriefs.generate(payload).pipe(Effect.catch(toActionFailed)));
  }),
);

const SettingsHandlers = HttpApiBuilder.group(
  MondashApi,
  "settings",
  Effect.fn(function* (handlers) {
    const settings = yield* SettingsManager;
    return handlers
      .handle("read", () => settings.read.pipe(Effect.catch(toActionFailed)))
      .handle("discover", ({ payload }) => settings.discover(payload.source).pipe(Effect.catch(toActionFailed)))
      .handle("apply", ({ payload }) => settings.apply(payload).pipe(Effect.catch(toActionFailed)))
      .handle("notionSearch", ({ payload }) => settings.notionSearch(payload.query).pipe(Effect.catch(toActionFailed)))
      .handle("notionInspect", ({ payload }) => settings.notionInspect(payload.id).pipe(Effect.catch(toActionFailed)));
  }),
);

const SetupHandlers = HttpApiBuilder.group(
  MondashApi,
  "setup",
  Effect.fn(function* (handlers) {
    const mcp = yield* Mcp;
    const dashboard = yield* Dashboard;
    const config = yield* ServerConfig;
    const response = Effect.gen(function* () {
      const saved = yield* Effect.try({
        try: () => readProfile(),
        catch: () =>
          new ActionFailed({
            message: "The saved profile is invalid. Restore mondash.local.json.previous before restarting.",
          }),
      });
      const health = yield* dashboard.health.pipe(Effect.catch(toSourceUnavailable));
      return {
        profile: saved,
        activeProfile: profile,
        restartRequired: JSON.stringify(saved) !== JSON.stringify(profile),
        coverage: coverage(health.connections, config),
      };
    }).pipe(Effect.mapError(() => new ActionFailed({ message: "Could not read setup. Check the server log." })));
    return handlers
      .handle("notion", () =>
        checkNotionSetup(mcp).pipe(
          Effect.mapError(
            () =>
              new ActionFailed({
                message:
                  "Could not inspect the Notion view. Save settings, restart the backend, connect Notion and retry.",
              }),
          ),
        ),
      )
      .handle("read", () => response)
      .handle("save", ({ payload }) =>
        Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: () => privateUpdate(profilePath(), () => decodeProfile(payload)),
            catch: () =>
              new ActionFailed({
                message:
                  "Profile could not be saved. Check field mappings, identity collisions, workspace scope and server log.",
              }),
          });
          return yield* response;
        }),
      );
  }),
);

const ApiRoutes = HttpApiBuilder.layer(MondashApi).pipe(
  Layer.provide([
    DashboardHandlers,
    ActivityHandlers,
    SessionHandlers,
    ActionHandlers,
    DebriefHandlers,
    SetupHandlers,
    SettingsHandlers,
    AgentAuthHandlers,
  ]),
);

/** A plain page for the browser: the provider sent you here, so say what failed and where to go next. */
const signInFailedPage = (server: string) =>
  HttpServerResponse.text(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign-in failed</title>
<body style="font:17px -apple-system,system-ui;max-width:32rem;margin:15vh auto;padding:0 16px">
<p>Mondash could not finish the ${server} sign-in. Start it again from Settings.</p>
<p><a href="/settings">Back to Settings</a></p></body>`,
    { status: 502, contentType: "text/html" },
  );

/** MCP sign-in: start sends you to the provider; the provider sends you back to callback. */
const AuthStart = HttpRouter.add(
  "GET",
  "/api/auth/:server/start",
  Effect.gen(function* () {
    const { server } = yield* HttpRouter.params;
    if (!server || !isServerName(server)) return HttpServerResponse.text("Unknown server", { status: 404 });
    const mcp = yield* Mcp;
    const settings = yield* SettingsManager;
    // Tailscale serve forwards the phone's requests with the tailnet host and https.
    const { headers } = yield* HttpServerRequest.HttpServerRequest;
    const host = headers["x-forwarded-host"] ?? headers["host"];
    const origin = `${headers["x-forwarded-proto"] ?? "http"}://${host}`;
    return yield* mcp.signIn(server, origin).pipe(
      Effect.flatMap((signIn) =>
        signIn._tag === "Redirect"
          ? Effect.succeed(HttpServerResponse.redirect(signIn.url))
          : settings
              .apply({ kind: "connect", source: server })
              .pipe(
                Effect.as(HttpServerResponse.redirect(`/settings?connection=${server}`)),
                Effect.catch(toActionFailed),
              ),
      ),
      Effect.catch((failure) =>
        Effect.logError(`Starting the ${server} sign-in failed`, failure.cause).pipe(
          Effect.as(signInFailedPage(server)),
        ),
      ),
    );
  }),
);

const AuthCallback = HttpRouter.add("GET", "/api/auth/:server/callback", (request) =>
  Effect.gen(function* () {
    const { server } = yield* HttpRouter.params;
    if (!server || !isServerName(server)) return HttpServerResponse.text("Unknown server", { status: 404 });
    const mcp = yield* Mcp;
    const settings = yield* SettingsManager;
    return yield* mcp.finishSignIn(server, new URL(request.url, "http://localhost").searchParams).pipe(
      Effect.andThen(settings.apply({ kind: "connect", source: server })),
      Effect.as(HttpServerResponse.redirect(`/settings?connection=${server}`)),
      Effect.catch((failure) =>
        Effect.logError(`Finishing the ${server} sign-in failed`, failure.cause).pipe(
          Effect.as(signInFailedPage(server)),
        ),
      ),
    );
  }),
);

// Chat apps rarely make exp:// links tappable, but they do make https ones.
const ExpoGoRoute = HttpRouter.add(
  "GET",
  "/expo",
  Effect.gen(function* () {
    const { expoGoUrl } = yield* ServerConfig;
    return HttpServerResponse.text(
      `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open in Expo Go</title>
<body style="font:17px -apple-system,system-ui;display:grid;place-items:center;min-height:90vh;margin:0">
<a href="${expoGoUrl}" style="padding:14px 22px;border-radius:12px;background:#245be0;color:#fff;text-decoration:none">Open Mondash in Expo Go</a>
<script>location.href=${JSON.stringify(expoGoUrl)}</script></body>`,
      { contentType: "text/html" },
    );
  }),
);

// The web app lived under /m while Next served the old dashboard at /; old links still land.
const OldWebPaths = HttpRouter.add("GET", "/m/*", (request) =>
  // "/m/*" also matches "/m" itself, whose remainder is empty.
  Effect.succeed(HttpServerResponse.redirect(new URL(request.url, "http://localhost").pathname.slice(2) || "/")),
);

// The standalone iPhone build (user agent "Mondash/1") reads /api/mobile/*; its actions stay broken until the next
// install. Delete this route only once the phone runs a new build: a day of traces without it proves nothing.
const LegacySection = HttpRouter.add(
  "GET",
  "/api/mobile/:section",
  Effect.gen(function* () {
    const { section } = yield* HttpRouter.params;
    const dashboard = yield* Dashboard;
    if (section !== "health" && !isSection(section))
      return HttpServerResponse.text("Unknown dashboard section", { status: 404 });
    const body: Effect.Effect<unknown, SourceFailure> =
      section === "health" ? dashboard.health : dashboard.section(section);
    return yield* Effect.flatMap(body, (value) => HttpServerResponse.json(value)).pipe(
      Effect.catch((failure) =>
        Effect.logError("Legacy section failed", failure).pipe(
          Effect.as(HttpServerResponse.text("Could not refresh", { status: 503 })),
        ),
      ),
    );
  }),
);

/**
 * The app's live copy of the sections, as server-sent events: a section whole when its content changes, and only its
 * `updatedAt` and `stale` when just those moved. On connect the app says which versions it has (`?have=issues:ab12,…`)
 * and gets the others. The sections are read from the store every 5 seconds, which also counts as someone looking
 * (`Dashboard.warm`). With nothing to send, a comment line goes instead: Bun closes a connection that is silent for
 * 10 seconds.
 * ponytail: each connection reads the store on its own; share one reader if more than a couple of clients connect.
 */
const SectionStream = HttpRouter.add("GET", "/api/stream", (request) =>
  Effect.gen(function* () {
    const dashboard = yield* Dashboard;
    const sent = sentFrom(new URL(request.url, "http://localhost").searchParams.get("have"));
    // Sections that failed to send, so each failure is logged once, not every 5 seconds.
    const failing = new Set<SectionName>();
    const events = Effect.forEach(SectionName.literals, (name) =>
      dashboard.section(name).pipe(
        Effect.flatMap((section) => sectionEvent(sent, name, section)),
        Effect.tap(() => Effect.sync(() => failing.delete(name))),
        Effect.catch((failure) => {
          if (failing.has(name)) return Effect.succeed("");
          failing.add(name);
          return Effect.logWarning(`The stream could not send the ${name} section`, failure).pipe(Effect.as(""));
        }),
        // Too frequent to trace. Provider calls under a read keep their spans (withIoSpan).
        Effect.withTracerEnabled(false),
      ),
    ).pipe(Effect.map((each) => each.join("") || ": alive\n\n"));
    const body = Stream.tick("5 seconds").pipe(
      Stream.mapEffect(() => events),
      Stream.encodeText,
    );
    return HttpServerResponse.stream(body, {
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache" },
    });
  }),
);

/**
 * The app's spans, passed on to the collector: the phone cannot reach it, and the web app would need CORS for it.
 */
const AppTraces = HttpRouter.add("POST", "/api/traces", (request) =>
  Effect.gen(function* () {
    const { otlpUrl } = yield* ServerConfig;
    if (!enabled("tracing") || Option.isNone(otlpUrl)) return HttpServerResponse.empty({ status: 204 });
    const body = yield* request.text;
    const response = yield* Effect.tryPromise((signal) =>
      fetch(`${otlpUrl.value}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      }),
    );
    return HttpServerResponse.empty({ status: response.ok ? 204 : 502 });
  }).pipe(
    Effect.catch((failure) =>
      Effect.logWarning("Passing on the app's spans failed", failure).pipe(
        Effect.as(HttpServerResponse.empty({ status: 502 })),
      ),
    ),
  ),
);

/** The phone app's web build; unknown paths get index.html so the app's own router takes them. */
const WebApp = HttpStaticServer.layer({ root: WEB_BUILD, spa: true });

/**
 * Actions change things (Slack read markers, Claude sessions), so a page on another site must not be able to post to
 * them from your browser. The app sends JSON from its own origin; the phone sends no Origin at all.
 */
const SameOriginActions = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (!enabled("sessions") && request.url.split("?")[0] === "/auth/claude")
        return HttpServerResponse.text("Local sessions are disabled in Settings", { status: 422 });
      if (
        !enabled("sessions") &&
        /^\/api\/(?:sessions(?:\/|$)|agent-auth(?:\/|$)|tickets\/session(?:\?|$)|prs\/session(?:\?|$)|reviews\/start(?:\?|$))/.test(
          request.url,
        )
      )
        return HttpServerResponse.text("Local sessions are disabled in Settings", { status: 422 });
      if (request.method === "GET" || request.method === "HEAD") return yield* httpEffect;
      const type = request.headers["content-type"];
      if (!type || !type.startsWith("application/json")) return HttpServerResponse.text("Send JSON", { status: 415 });
      const origin = request.headers["origin"];
      const config = yield* ServerConfig;
      const allowed = [...origins(config.publicUrl, undefined, config.port).all, `http://127.0.0.1:${config.port}`];
      if (origin && !allowed.includes(origin))
        return HttpServerResponse.text("Cross-site action rejected", { status: 403 });
      // Validate the unstripped JSON before the typed API codec, which otherwise drops extra fields.
      if (request.method === "PUT" && request.url.split("?")[0] === "/api/setup") {
        const valid = yield* request.json.pipe(
          Effect.flatMap((input) => Effect.try(() => decodeProfile(input))),
          Effect.orElseSucceed(() => undefined),
        );
        if (!valid)
          return HttpServerResponse.jsonUnsafe(
            {
              _tag: "ActionFailed",
              message: "Invalid workspace profile. Check unknown fields, mappings and identity collisions.",
            },
            { status: 422 },
          );
      }
      return yield* httpEffect;
    }),
  { global: true },
);

/** Unexpected handler failures. Declared failures are logged by their handlers. */
const ReportFailures = ErrorReporter.layer([
  ErrorReporter.make(({ cause, error, fiber }) => {
    if (error instanceof ActionFailed || error instanceof SourceUnavailable) return;
    Effect.runForkWith(fiber.context)(Effect.logError("Request failed", cause));
  }),
]);

/** Effect suppresses schema error reporting for both directions; invalid server responses still need diagnostics. */
const ReportResponseFailures = HttpRouter.middleware(
  (next) =>
    next.pipe(
      Effect.tapCause((cause) =>
        cause.reasons.some(
          (reason) =>
            Cause.isDieReason(reason) &&
            HttpApiError.HttpApiSchemaError.is(reason.defect) &&
            (reason.defect.kind === "Body" || reason.defect.kind === "ResponseHeaders"),
        )
          ? Effect.logError("Request failed", cause)
          : Effect.void,
      ),
    ),
  { global: true },
);

/**
 * For HttpRouter.serve: only API requests make spans. Static files are noise, and the requests that pass on the app's
 * spans would each start a trace of their own.
 */
export const UntracedRequests = Layer.succeed(HttpMiddleware.TracerDisabledWhen)(
  (request) =>
    !request.url.startsWith("/api/") || request.url.startsWith("/api/traces") || request.url.startsWith("/api/stream"),
);

/** The bundled Mac backend is private even on loopback. Browser sessions are owned by its separate gateway. */
const LocalCapability = HttpRouter.middleware(
  (next) =>
    Effect.gen(function* () {
      const cap = process.env.MONDASH_LOCAL_CAPABILITY;
      if (!cap) return yield* next;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const header = request.headers["x-mondash-capability"];
      const cookie = request.headers["cookie"]
        ?.split(";")
        .map((value) => value.trim())
        .find((value) => value.startsWith("mondash-native="))
        ?.slice(15);
      const provided = header ?? cookie;
      if (
        !provided ||
        !/^[a-f0-9]{64}$/.test(provided) ||
        provided.length !== cap.length ||
        !timingSafeEqual(Buffer.from(provided), Buffer.from(cap))
      )
        return HttpServerResponse.text("Local authorization required", { status: 401 });
      const response = yield* next;
      return header === cap && request.method === "GET" && !request.url.startsWith("/api/")
        ? HttpServerResponse.setHeader(response, "set-cookie", `mondash-native=${cap}; Path=/; HttpOnly; SameSite=Lax`)
        : response;
    }),
  { global: true },
);

/** Every route. It needs the services: main.ts provides the live ones, the tests provide fakes. */
export const Routes = Layer.mergeAll(
  ApiRoutes,
  ReportResponseFailures,
  AuthStart,
  AuthCallback,
  ClaudeSignInRedirect,
  ExpoGoRoute,
  OldWebPaths,
  LegacySection,
  WebApp,
  SameOriginActions,
  LocalCapability,
  AppTraces,
  SectionStream,
).pipe(Layer.provide(ReportFailures));
