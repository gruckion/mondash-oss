import type { SettingsCommand, WorkSource } from "@mondash/shared/settings";
import { Cause, Data, Duration, Effect, Exit, Layer, ManagedRuntime, Option, Schema } from "effect";
import { FetchHttpClient, HttpClientError } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { OtlpSerialization, OtlpTracer } from "effect/observability";
import { ActionFailed, MondashApi, type PromptRequest, SourceUnavailable } from "@mondash/shared/api";
import type { SectionName } from "@mondash/shared/contract";
import type { SessionSearchInput } from "@mondash/shared/session-search";
import { fetchFor } from "./transport";

export function normalizeServer(value: string): string {
  const url = new URL(value.trim());
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("Enter the server address, such as https://your-mac.ts.net:8443");
  }
  return url.origin;
}

type Client = HttpApiClient.ForApi<typeof MondashApi>;
type CallKind = "load" | "action";

const UNREACHABLE = "Open Mondash on your Mac and check its internet connection, then try again.";
const MISMATCH = "The Mac returned an incompatible response. Update Mondash and the backend together.";

/** A response that did not fit the contract, kept apart from a request the phone could not encode. */
class ResponseMismatch extends Data.TaggedError("ResponseMismatch")<{ readonly cause: Schema.SchemaError }> {}

/** The client encodes the request and decodes the response in one effect; this tags the decoding failures. */
export const makeClient = (baseUrl: string) =>
  HttpApiClient.make(MondashApi, {
    baseUrl,
    transformResponse: (response) =>
      Effect.mapError(response, (error) =>
        Schema.isSchemaError(error) ? new ResponseMismatch({ cause: error }) : error,
      ),
  });

/**
 * Words for the person, whatever went wrong between the phone and the Mac. Only a request that never got an answer
 * asks to check the Mac connection: when the Mac answers with an error, the message says so.
 */
export function describe(failure: unknown, kind: CallKind): string {
  if (failure instanceof ActionFailed || failure instanceof SourceUnavailable) return failure.message;
  if (Cause.isTimeoutError(failure))
    return kind === "load"
      ? "The Mac took too long to respond. Pull to try again."
      : "The Mac took too long to respond. It may still finish, so check before you try again.";
  if (failure instanceof ResponseMismatch) return MISMATCH;
  // A schema failure that is not a response is a request this phone could not encode, so it never reached the Mac.
  if (Schema.isSchemaError(failure))
    return "The request was not sent because an input is not valid. Check it, then try again.";
  if (!HttpClientError.isHttpClientError(failure)) return UNREACHABLE;
  const { reason } = failure;
  if (reason._tag === "TransportError") return UNREACHABLE;
  if (reason._tag === "InvalidUrlError") return "Check the server address in Settings.";
  // A status the API does not declare arrives as a decode error that still carries the response.
  const status = "response" in reason ? reason.response.status : undefined;
  if (status !== undefined && status >= 500)
    return `Mondash on your Mac hit an error (HTTP ${status}). Check its log, then try again.`;
  if (status !== undefined && status >= 400) return `The Mac refused the request (HTTP ${status}). Try again.`;
  return MISMATCH;
}

/** True when a call failed because the Mac did not answer in time. */
export const isTimeout = (error: unknown) => error instanceof Error && Cause.isTimeoutError(error.cause);

/**
 * One HTTP client per server address for the app's lifetime. Its spans go to that Mac, which passes them to its
 * collector, so a trace runs from the tap to the work on the Mac.
 */
const makeRuntime = (server: string) => {
  const transport = FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFor(server))));
  return ManagedRuntime.make(
    Layer.mergeAll(
      transport,
      OtlpTracer.layer({ url: `${server}/api/traces`, resource: { serviceName: "mondash-app" } }).pipe(
        Layer.provide([transport, OtlpSerialization.layerJson]),
      ),
    ),
  );
};
type Connection = { readonly runtime: ReturnType<typeof makeRuntime>; client?: Client };
const connections = new Map<string, Connection>();

const connectionFor = (server: string): Connection => {
  const known = connections.get(server);
  if (known) return known;
  const made: Connection = { runtime: makeRuntime(server) };
  connections.set(server, made);
  return made;
};

/**
 * Calls the Mac through the client derived from MondashApi, so a renamed endpoint or a changed field is a type error
 * here, not a runtime surprise. Failures become Errors with a message fit to show.
 */
async function call<A, E>(
  server: string,
  span: string,
  use: (client: Client) => Effect.Effect<A, E>,
  options: { kind: CallKind; timeout: Duration.Input; signal?: AbortSignal; attributes?: Record<string, unknown> },
): Promise<A> {
  const connection = connectionFor(server);
  const client = Effect.gen(function* () {
    if (connection.client) return connection.client;
    connection.client = yield* makeClient(server);
    return connection.client;
  });
  const program = client.pipe(
    Effect.flatMap(use),
    Effect.timeout(options.timeout),
    Effect.withSpan(span, { attributes: options.attributes }),
  );
  const exit = await connection.runtime.runPromiseExit(program, { signal: options.signal });
  if (Exit.isSuccess(exit)) return exit.value;
  if (__DEV__ && !Cause.hasInterruptsOnly(exit.cause)) console.warn(`${span} failed\n${Cause.pretty(exit.cause)}`);
  const found = Cause.findErrorOption(exit.cause);
  const failure = Option.isSome(found) ? found.value : Cause.squash(exit.cause);
  throw new Error(describe(failure, options.kind), { cause: failure });
}

/** Short, and the queries do not retry a timeout, so a hung Mac shows an error in seconds. */
const LOAD_TIMEOUT = "15 seconds";

export const loadSection = (server: string, section: SectionName, signal?: AbortSignal) =>
  call(server, "loadSection", (client) => client.dashboard.section({ params: { section } }), {
    kind: "load",
    timeout: LOAD_TIMEOUT,
    signal,
    attributes: { section },
  });

export const searchSessions = (server: string, input: SessionSearchInput, signal?: AbortSignal) =>
  call(server, "sessionSearch", (client) => client.sessions.search({ payload: input }), {
    kind: "load",
    timeout: Duration.seconds(90 * Math.max(1, Math.ceil(input.candidates.length / 150))),
    signal,
  });

/** The recent conversation of a session on the Mac, as Markdown turns. */
export const loadConversation = (server: string, tool: "claude" | "codex", id: string, signal?: AbortSignal) =>
  call(server, "sessionConversation", (client) => client.sessions.conversation({ params: { tool, id } }), {
    kind: "load",
    timeout: LOAD_TIMEOUT,
    signal,
    attributes: { tool, sessionId: id },
  });

export const loadSessionPullRequests = (server: string, tool: "claude" | "codex", id: string, signal?: AbortSignal) =>
  call(server, "sessionPullRequests", (client) => client.sessions.pullRequests({ params: { tool, id } }), {
    kind: "load",
    timeout: "45 seconds",
    signal,
    attributes: { tool, sessionId: id },
  });

export const loadSessionAttachment = (
  server: string,
  tool: "claude" | "codex",
  id: string,
  attachmentId: string,
  signal?: AbortSignal,
) =>
  call(server, "sessionAttachment", (client) => client.sessions.attachment({ params: { tool, id, attachmentId } }), {
    kind: "load",
    timeout: LOAD_TIMEOUT,
    signal,
    attributes: { tool, sessionId: id, attachmentId },
  });

export const startClaudeSignIn = (server: string) =>
  call(server, "startClaudeSignIn", (client) => client.agentAuth.startClaude({ payload: {} }), {
    kind: "action",
    timeout: "15 seconds",
  });

export const loadHealth = (server: string, signal?: AbortSignal) =>
  call(server, "health", (client) => client.dashboard.health(), { kind: "load", timeout: LOAD_TIMEOUT, signal });

export const openDesktopLink = (server: string, url: string) =>
  call(server, "openDesktopLink", (client) => client.actions.openDesktopLink({ payload: { url } }), {
    kind: "action",
    timeout: "8 seconds",
  });

export const linkThread = (server: string, ticketId: string, url: string, force = false) =>
  call(server, "linkSlackThread", (client) => client.actions.linkSlackThread({ payload: { ticketId, url, force } }), {
    kind: "action",
    timeout: "60 seconds",
  });

export const openSessionOnMac = (server: string, sessionId: string, target: "terminal" | "claude-desktop") =>
  call(server, "openOnMac", (client) => client.actions.openOnMac({ payload: { sessionId, target } }), {
    kind: "action",
    timeout: "15 seconds",
  });

export const openRemoteSession = (server: string, sessionId: string, tool: "claude" | "codex") =>
  call(server, "openSession", (client) => client.actions.openSession({ payload: { sessionId, tool } }), {
    kind: "action",
    timeout: "60 seconds",
  });

/**
 * A PR risk review of the PR; `startNew` starts another even when one exists, else that one reopens. `prompt` replaces
 * the first message of a new review.
 */
export const startClaudeReview = (server: string, url: string, startNew = false, prompt?: string) =>
  call(server, "startReview", (client) => client.actions.startReview({ payload: { url, startNew, prompt } }), {
    kind: "action",
    timeout: "120 seconds",
  });

/** The prompt a start would send Claude, for the person to read and edit first. A review gathers its PRs for it. */
export const previewPrompt = (server: string, request: typeof PromptRequest.Type, signal?: AbortSignal) =>
  call(
    server,
    "promptPreview",
    // The client takes each kind of request on its own, not their union.
    (client) =>
      request.kind === "ticket"
        ? client.actions.promptPreview({ payload: request })
        : request.kind === "pr"
          ? client.actions.promptPreview({ payload: request })
          : client.actions.promptPreview({ payload: request }),
    {
      kind: "action",
      timeout: "120 seconds",
      signal,
      attributes: { kind: request.kind },
    },
  );

export const archiveSession = (server: string, tool: "claude" | "codex", sessionId: string, archived: boolean) =>
  call(server, "archiveSession", (client) => client.sessions.archive({ payload: { tool, sessionId, archived } }), {
    kind: "action",
    timeout: "60 seconds",
  });

export const markFeedRead = (server: string, id: string, read: boolean) =>
  call(server, "markRead", (client) => client.actions.markRead({ payload: { id, read } }), {
    kind: "action",
    timeout: "60 seconds",
  });

/** Starts an empty Claude session on the Mac in auto mode; the result opens it on the phone. */
export const startNewSession = (server: string) =>
  call(server, "newSession", (client) => client.actions.newSession({ payload: { tool: "claude" } }), {
    timeout: "60 seconds",
    kind: "action",
  });

/**
 * Starts a Claude session on the Mac that reads the ticket and plans the change; the result opens it on the phone.
 * `prompt` replaces its first message.
 */
export const startTicketSession = (
  server: string,
  ticketId: string,
  url: string,
  prs: readonly string[],
  prompt?: string,
) =>
  call(server, "ticketSession", (client) => client.actions.ticketSession({ payload: { ticketId, url, prs, prompt } }), {
    timeout: "60 seconds",
    kind: "action",
    attributes: { ticketId },
  });

/**
 * Starts a Claude session on the Mac that reads a PR and works out what is left; the result opens it on the phone.
 * `prompt` replaces its first message.
 */
export const startPrSession = (server: string, url: string, prompt?: string) =>
  call(server, "prSession", (client) => client.actions.prSession({ payload: { url, prompt } }), {
    timeout: "60 seconds",
    kind: "action",
    attributes: { url },
  });

/** Resumes a Claude Code session in the Mac's terminal app. */
export const openInTerminal = (server: string, sessionId: string) =>
  call(server, "openInTerminal", (client) => client.actions.openInTerminal({ payload: { sessionId } }), {
    kind: "action",
    timeout: "30 seconds",
  });

export const loadDebrief = (server: string, signal?: AbortSignal) =>
  call(server, "debrief", (client) => client.debrief.read(), { kind: "load", timeout: LOAD_TIMEOUT, signal });
export const loadActivity = (server: string, signal?: AbortSignal) =>
  call(server, "activity", (client) => client.activity.read(), { kind: "load", timeout: LOAD_TIMEOUT, signal });
export const generateDebrief = (server: string, since: string, until: string) =>
  call(server, "generateDebrief", (client) => client.debrief.generate({ payload: { since, until } }), {
    kind: "action",
    timeout: LOAD_TIMEOUT,
  });

export const loadDebriefHistory = (server: string, signal?: AbortSignal) =>
  call(server, "debriefHistory", (client) => client.debrief.history(), { kind: "load", timeout: LOAD_TIMEOUT, signal });
export const loadDebriefReport = (server: string, id: string, signal?: AbortSignal) =>
  call(server, "debriefReport", (client) => client.debrief.report({ params: { id } }), {
    kind: "load",
    timeout: LOAD_TIMEOUT,
    signal,
  });

export const loadConnections = (server: string, signal?: AbortSignal) =>
  call(server, "connections", (client) => client.settings.read(), { kind: "load", timeout: LOAD_TIMEOUT, signal });
export const discoverAccount = (server: string, source: WorkSource) =>
  call(server, "discoverAccount", (client) => client.settings.discover({ payload: { source } }), {
    kind: "action",
    timeout: LOAD_TIMEOUT,
  });
export const applySettings = (server: string, payload: SettingsCommand) =>
  call(
    server,
    "applySettings",
    (client) =>
      (() => {
        switch (payload.kind) {
          case "connect":
            return client.settings.apply({ payload });
          case "disconnect":
            return client.settings.apply({ payload });
          case "scope":
            return client.settings.apply({ payload });
          case "feature":
            return client.settings.apply({ payload });
          case "notion":
            return client.settings.apply({ payload });
        }
      })(),
    {
      kind: "action",
      timeout: LOAD_TIMEOUT,
    },
  );
export const searchNotionBoards = (server: string, query: string) =>
  call(server, "searchNotionBoards", (client) => client.settings.notionSearch({ payload: { query } }), {
    kind: "load",
    timeout: LOAD_TIMEOUT,
  });
export const inspectNotionBoard = (server: string, id: string) =>
  call(server, "inspectNotionBoard", (client) => client.settings.notionInspect({ payload: { id } }), {
    kind: "load",
    timeout: LOAD_TIMEOUT,
  });

export const loadSessionFiles = (server: string, tool: "claude" | "codex", id: string, signal?: AbortSignal) =>
  call(server, "sessionFiles", (client) => client.sessions.files({ params: { tool, id } }), {
    kind: "load",
    timeout: LOAD_TIMEOUT,
    signal,
    attributes: { tool, sessionId: id },
  });
