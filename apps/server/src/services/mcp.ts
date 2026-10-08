import { ConnectionSetup } from "../connection-setup";
import { enabled } from "../profile";
import { SdkError, SdkErrorCode, SdkHttpError, UnauthorizedError } from "@modelcontextprotocol/client";
import { Clock, Context, DateTime, type Duration, Effect, Layer, Option, Schema } from "effect";
import { ServerConfig } from "@/config";
import * as mcp from "@/lib/mcp";
import { Store, storeKey, type StoreFailure } from "./store";
import { causeText } from "./errors";
import { withBackoff } from "./retry";
import { withIoSpan } from "@/tracing";

/** Talking to the Slack or Notion MCP server failed. */
export class McpFailure extends Schema.TaggedError<McpFailure>()("McpFailure", {
  server: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message() {
    return `MCP ${this.server}: ${causeText(this.cause)}`;
  }
}

/** Where sign-in stands: already connected, or a provider page to send you to. */
export type SignIn = { readonly _tag: "Connected" } | { readonly _tag: "Redirect"; readonly url: string };

export const Health = Schema.Struct({
  ok: Schema.Boolean,
  at: Schema.String,
  message: Schema.optional(Schema.String),
  needsSignIn: Schema.optional(Schema.Boolean),
  toolFailure: Schema.optional(Schema.String),
});
/** Whether the last call to a server worked, so Settings can show it. */
export type Health = typeof Health.Type;

/**
 * Whether a working connection's health can stay as stored: it is rewritten at most every 5 minutes, so Settings'
 * "checked" time stays close to the last call without a write per call.
 */
export const healthCurrent = (before: Health | undefined, ok: boolean, now: number) =>
  before !== undefined && before.ok && ok && now - Date.parse(before.at) < 5 * 60_000;
const healthKey = (server: mcp.ServerName) => storeKey(`health:${server}`, Health);

/** The store key `cachedCall` keeps a tool call's text under. */
const cachedCallKey = (server: mcp.ServerName, tool: string, args: Record<string, unknown>) =>
  `mcp:${server}:${tool}:${JSON.stringify(args)}`;

const DROPPED = new Set<SdkErrorCode>([
  SdkErrorCode.ConnectionClosed,
  SdkErrorCode.NotConnected,
  SdkErrorCode.SendFailed,
]);
// Bun's fetch sets these codes; Node's says "fetch failed" and puts the socket error in `cause`.
const NETWORK = new Set([
  "ConnectionRefused",
  "ConnectionClosed",
  "FailedToOpenSocket",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
]);

/** A rate limit or a server error from the MCP server, which a later try can get past. Connection errors reconnect. */
export const transientMcp = (failure: McpFailure): boolean =>
  failure.cause instanceof SdkHttpError && (failure.cause.status === 429 || failure.cause.status >= 500);

/**
 * Whether a failed call means the client's connection or session is gone (closed transport, network failure, HTTP 401
 * or 404 for an expired session), so a new client may succeed. A rate limit or a server's answer to a bad call is not.
 */
export const isConnectionError = (error: unknown): boolean => {
  if (error instanceof SdkHttpError) return error.status === 401 || error.status === 404;
  if (error instanceof SdkError) return DROPPED.has(error.code);
  if (error instanceof UnauthorizedError) return true;
  if (!(error instanceof Error)) return false;
  if ("code" in error && typeof error.code === "string" && NETWORK.has(error.code)) return true;
  return (error instanceof TypeError && error.message === "fetch failed") || isConnectionError(error.cause);
};

/**
 * One shared client per server, so each call skips the ~1.8 s connect. A call that fails because the connection is
 * gone drops the client and runs once more on a new one. Any other failure leaves the client to the calls in flight.
 */
export const clientPool = <C extends { close(): Promise<void> }>(connect: (server: mcp.ServerName) => Promise<C>) => {
  const clients = new Map<mcp.ServerName, Promise<C>>();

  const shared = (server: mcp.ServerName): Promise<C> => {
    const existing = clients.get(server);
    if (existing) return existing;
    const client = connect(server);
    client.catch(() => drop(server, client)); // a failed connect is not kept
    clients.set(server, client);
    return client;
  };

  /** Forgets a client, unless another request has already replaced it. */
  const drop = (server: mcp.ServerName, client: Promise<C>) => {
    if (clients.get(server) !== client) return;
    clients.delete(server);
    client.then((c) => c.close()).catch(() => {});
  };

  const use = async <A>(server: mcp.ServerName, run: (client: C) => Promise<A>, retry = true): Promise<A> => {
    const client = shared(server);
    try {
      return await run(await client);
    } catch (error) {
      if (!retry || !isConnectionError(error)) throw error;
      drop(server, client);
      return use(server, run, false);
    }
  };

  const closeAll = () => Promise.allSettled([...clients.values()].map(async (client) => (await client).close()));
  const reset = (server: mcp.ServerName) => {
    const client = clients.get(server);
    if (client) drop(server, client);
  };

  return { use, closeAll, reset };
};

/** The Slack and Notion MCP servers: sign-in, the connection state and tool calls. */
export class Mcp extends Context.Service<
  Mcp,
  {
    /** `origin` is where the request came from; the sign-in comes back there when it is a known address of this Mac. */
    signIn(server: mcp.ServerName, origin: string): Effect.Effect<SignIn, McpFailure>;
    finishSignIn(server: mcp.ServerName, params: URLSearchParams): Effect.Effect<void, McpFailure>;
    /** Calls a tool and returns its text. A dropped connection is reopened once; any other failure fails the call. */
    call(server: mcp.ServerName, tool: string, args: Record<string, unknown>): Effect.Effect<string, McpFailure>;
    /** A tool call whose text is kept in the store for `fresh`, keyed by server, tool and arguments. */
    cachedCall(
      server: mcp.ServerName,
      tool: string,
      args: Record<string, unknown>,
      fresh: Duration.Input,
    ): Effect.Effect<string, McpFailure | StoreFailure>;
    /** The saved OAuth access token, for APIs the MCP server does not cover (for example Slack avatars). */
    accessToken(server: mcp.ServerName, rejectedToken?: string): Effect.Effect<string | undefined, McpFailure>;
    hasTokens(server: mcp.ServerName): Effect.Effect<boolean, McpFailure>;
    health(server: mcp.ServerName): Effect.Effect<Health | undefined, StoreFailure>;
    /** A read-only MCP round trip, for current connection status without loading a whole section. */
    probe(server: mcp.ServerName): Effect.Effect<void>;
  }
>()("mondash/server/Mcp") {
  /** The live implementation with an injectable transport for OAuth recovery tests. */
  static make(transport: Pick<typeof mcp, "connect" | "hasTokens" | "finishAuth" | "accessToken"> = mcp) {
    return Effect.gen(function* () {
      const { slackClient, publicUrl, port } = yield* ServerConfig;
      const store = yield* Store;

      // Closed with the server.
      // Signed out: fail without a network round trip, since every call tries to connect again.
      const clients = clientPool(async (server) => {
        if (!(await transport.hasTokens(server))) throw new UnauthorizedError(`${server} is not connected`);
        const result = await transport.connect(server, slackClient);
        if ("authUrl" in result) throw new UnauthorizedError(`${server} is not connected`);
        return result.client;
      });
      yield* Effect.addFinalizer(() => Effect.promise(clients.closeAll));

      const callTool = async (server: mcp.ServerName, tool: string, args: Record<string, unknown>): Promise<string> => {
        const response = await clients.use(server, (client) =>
          mcp.withOAuthLock(server, () => client.callTool({ name: tool, arguments: args })),
        );
        const text = response.content.find((block) => block.type === "text");
        if (!text || text.type !== "text") throw new Error(`${server}.${tool} failed with no text`);
        // The tool's own error text says why (bad input, quota, permissions), so keep it.
        if (response.isError) throw new Error(`${server}.${tool} failed: ${text.text.slice(0, 300)}`);
        return text.text;
      };

      const health = (server: mcp.ServerName) =>
        store.read(healthKey(server)).pipe(Effect.map((stored) => stored?.value));

      const record = (
        server: mcp.ServerName,
        ok: boolean,
        message?: string,
        needsSignIn?: boolean,
        source?: "probe" | "tool",
      ) =>
        Effect.gen(function* () {
          const before = yield* health(server);
          // Keep unresolved data failures through both failed and successful connectivity probes.
          const toolFailure =
            source === "probe"
              ? before?.toolFailure
              : source === "tool" && !ok && !needsSignIn
                ? (message ?? "Data refresh failed")
                : undefined;
          const healthy = ok && toolFailure === undefined;
          if (healthCurrent(before, healthy, yield* Clock.currentTimeMillis)) return;
          const at = DateTime.formatIso(yield* DateTime.now);
          yield* store.write(healthKey(server), {
            ok: healthy,
            at,
            ...(ok && toolFailure !== undefined ? { message: toolFailure } : message === undefined ? {} : { message }),
            ...(needsSignIn ? { needsSignIn } : {}),
            ...(toolFailure === undefined ? {} : { toolFailure }),
          });
        }).pipe(Effect.catch((failure) => Effect.logWarning(`Could not record the ${server} health`, failure)));

      const call = (server: mcp.ServerName, tool: string, args: Record<string, unknown>) =>
        Effect.gen(function* () {
          if (!enabled(server) && !(yield* ConnectionSetup))
            return yield* new McpFailure({ server, cause: "Source is disconnected" });
          return yield* Effect.tryPromise({
            try: () => callTool(server, tool, args),
            catch: (cause) => new McpFailure({ server, cause }),
          });
        }).pipe(
          withBackoff({ retryable: transientMcp }),
          Effect.tap(() => record(server, true)),
          Effect.tapError((failure) =>
            record(
              server,
              false,
              String(failure.cause instanceof Error ? failure.cause.message : failure.cause).slice(0, 200),
              failure.cause instanceof UnauthorizedError ||
                (failure.cause instanceof SdkHttpError && failure.cause.status === 401),
              "tool",
            ),
          ),
          withIoSpan("Mcp.call", { attributes: { server, tool } }),
        );

      const tokens = (server: mcp.ServerName, rejectedToken?: string) =>
        Effect.gen(function* () {
          if (!enabled(server) && !(yield* ConnectionSetup)) return undefined;
          return yield* Effect.tryPromise({
            try: () => transport.accessToken(server, slackClient, rejectedToken),
            catch: (cause) => new McpFailure({ server, cause }),
          });
        });

      const recovered = (server: mcp.ServerName) =>
        Effect.gen(function* () {
          clients.reset(server);
          const prefixes =
            server === "notion" ? ["mcp:notion:", "roadmap:"] : ["mcp:slack:", "slack:", "feed:slack", "triage:"];
          yield* Effect.forEach(prefixes, (prefix) => store.retryPrefix(prefix), { discard: true });
          yield* record(server, true);
        });

      return Mcp.of({
        probe: (server) =>
          Effect.tryPromise({
            try: () => clients.use(server, (client) => client.listTools()),
            catch: (cause) => new McpFailure({ server, cause }),
          }).pipe(
            Effect.timeout("8 seconds"),
            Effect.asVoid,
            Effect.tap(() => record(server, true, undefined, undefined, "probe")),
            Effect.catch((failure) => {
              const error = failure instanceof McpFailure ? failure.cause : failure;
              return record(
                server,
                false,
                undefined,
                error instanceof UnauthorizedError || (error instanceof SdkHttpError && error.status === 401),
                "probe",
              );
            }),
          ),
        signIn: Effect.fn("Mcp.signIn")(function* (server, origin) {
          const where = yield* Effect.try({
            try: () => mcp.origins(publicUrl, origin, port),
            catch: (cause) => new McpFailure({ server, cause }),
          });
          const result = yield* Effect.tryPromise({
            try: () => transport.connect(server, slackClient, where),
            catch: (cause) => new McpFailure({ server, cause }),
          });
          if ("authUrl" in result) return { _tag: "Redirect", url: result.authUrl } satisfies SignIn;
          // Already signed in: the check only needed to connect, so a failed close does not stop you.
          yield* Effect.tryPromise(() => result.client.close()).pipe(
            Effect.catch((cause) => Effect.logWarning(`Closing the ${server} MCP client failed`, cause)),
          );
          yield* recovered(server);
          return { _tag: "Connected" } satisfies SignIn;
        }),
        finishSignIn: (server, params) =>
          Effect.tryPromise({
            try: () => {
              return transport.finishAuth(server, params, slackClient, publicUrl, port);
            },
            catch: (cause) => new McpFailure({ server, cause }),
          }).pipe(
            Effect.tap(() => recovered(server)),
            Effect.withSpan("Mcp.finishSignIn", { attributes: { server } }),
          ),
        call,
        cachedCall: (server, tool, args, fresh) =>
          store.cached(storeKey(cachedCallKey(server, tool, args), Schema.String), fresh, call(server, tool, args)),
        accessToken: tokens,
        hasTokens: (server) =>
          Effect.gen(function* () {
            if (!enabled(server) && !(yield* ConnectionSetup)) return false;
            return yield* Effect.tryPromise({
              try: () => transport.hasTokens(server),
              catch: (cause) => new McpFailure({ server, cause }),
            });
          }),
        health,
      });
    });
  }

  static readonly layer = Layer.effect(Mcp, Mcp.make());
}
