import { privateUpdate } from "../private-files";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import {
  Client,
  auth,
  type OAuthDiscoveryState,
  type FetchLike,
  type OAuthClientInformationContext,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { Option, Redacted, Schema } from "effect";
import type { Settings } from "@/config";

export type ServerName = "slack" | "notion";

const SERVERS: Record<ServerName, string> = {
  slack: "https://mcp.slack.com/mcp",
  notion: "https://mcp.notion.com/mcp",
};

export const isServerName = (s: string): s is ServerName => Object.hasOwn(SERVERS, s);

export const LOCAL_ORIGIN = "http://localhost:3456";
const DIR = ".mcp-auth";
// Same-Mac previews borrow access tokens only. The original backend alone owns refresh and sign-in.
const readOnlyDirectory = () => process.env.MONDASH_OAUTH_READ_ONLY_DIR || undefined;
const previewSignInError = () => new Error("This preview shares sign-in read-only. Reconnect in the original Mondash.");

type Stored = {
  client?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  verifier?: string;
  state?: string;
  /** Where the sign-in in progress comes back to, so finishing it uses the same address. */
  redirect?: string;
  discovery?: OAuthDiscoveryState;
  issuedAt?: number;
};

/**
 * Where a sign-in may come back to: this Mac, and its public (tailnet) address when set, so the phone can sign in too.
 * `origin` is the one this sign-in started from.
 */
export type Origins = { readonly all: ReadonlyArray<string>; readonly origin: string };
export const origins = (publicUrl: Option.Option<string>, origin?: string, port = 3456): Origins => {
  const local = `http://localhost:${port}`;
  let browserOrigin: string | undefined;
  try {
    const value = Schema.decodeUnknownSync(Schema.Struct({ localOrigin: Schema.String }))(
      JSON.parse(readFileSync("browser-gateway.json", "utf8")),
    );
    const url = new URL(value.localOrigin);
    if (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(url.hostname) &&
      url.port &&
      url.origin === value.localOrigin
    )
      browserOrigin = url.origin;
  } catch {
    /* A CLI install has no app-owned browser gateway. */
  }
  const all = [
    ...new Set([
      local,
      `http://127.0.0.1:${port}`,
      ...Option.toArray(publicUrl).filter(Boolean),
      ...(browserOrigin ? [browserOrigin] : []),
    ]),
  ];
  if (origin && !all.includes(origin)) throw new Error("OAuth origin is not a configured Mondash address");
  return { all, origin: origin ?? local };
};
const callback = (origin: string, name: ServerName) => `${origin}/api/auth/${name}/callback`;

// ponytail: plain JSON files (gitignored), local-only; move to OS keychain before this leaves localhost.
// One file per server, so client info is not keyed by issuer.
export class FileProvider implements OAuthClientProvider {
  authUrl?: URL;
  readonly redirectUrl: string;
  readonly clientMetadata: OAuthClientMetadata;

  constructor(
    readonly name: ServerName,
    private readonly slackClient: Settings["slackClient"] = Option.none(),
    where: Origins = origins(Option.none()),
    private readonly directory = DIR,
  ) {
    this.redirectUrl = callback(where.origin, name);
    this.clientMetadata = {
      client_name: "Mondash",
      redirect_uris: where.all.map((origin) => callback(origin, name)),
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // Slack has no dynamic client registration: it uses the pre-registered app in .env.
      token_endpoint_auth_method: name === "slack" ? "client_secret_post" : "none",
    };
  }

  async load(): Promise<Stored> {
    try {
      return JSON.parse(await readFile(`${this.directory}/${this.name}.json`, "utf8"));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
      throw new Error("Saved OAuth file is unreadable; restore its previous version or reconnect");
    }
  }

  async completeAuthorization() {
    await this.save({ state: undefined, redirect: undefined, verifier: undefined });
  }

  private async save(patch: Stored) {
    await privateUpdate(`${this.directory}/${this.name}.json`, (before) => ({
      ...((before as Stored) ?? {}),
      ...patch,
    }));
  }
  async discoveryState() {
    return (await this.load()).discovery;
  }
  async saveDiscoveryState(discovery: OAuthDiscoveryState) {
    await this.save({ discovery });
  }
  async state() {
    const state = crypto.randomUUID();
    await this.save({ state, redirect: this.redirectUrl });
    return state;
  }
  async clientInformation(ctx?: OAuthClientInformationContext) {
    if (this.name === "slack") {
      if (Option.isNone(this.slackClient)) throw new Error("Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET in .env");
      const issuer = "https://mcp.slack.com";
      if (ctx && ctx.issuer !== issuer) throw new Error("Slack OAuth issuer mismatch");
      return {
        client_id: this.slackClient.value.id,
        client_secret: Redacted.value(this.slackClient.value.secret),
        issuer,
      };
    }
    const { client } = await this.load();
    // Registered before this return address existed: register again, so the provider accepts it.
    if (client && "redirect_uris" in client && !client.redirect_uris.includes(this.redirectUrl)) return undefined;
    return ctx && client?.issuer && client.issuer !== ctx.issuer ? undefined : client;
  }
  async saveClientInformation(client: StoredOAuthClientInformation) {
    await this.save({ client });
  }
  async tokens(ctx?: OAuthClientInformationContext) {
    const tokens = (await this.load()).tokens;
    return ctx && tokens?.issuer && tokens.issuer !== ctx.issuer ? undefined : tokens;
  }
  async saveTokens(tokens: StoredOAuthTokens) {
    await privateUpdate(`${this.directory}/${this.name}.json`, (input) => {
      const before = (input as Stored) ?? {};
      const prior = before.tokens;
      const issuer = tokens.issuer ?? before.discovery?.authorizationServerUrl ?? prior?.issuer;
      const sameIssuer = !prior?.issuer || prior.issuer === issuer;
      return {
        ...before,
        tokens: {
          ...tokens,
          ...(issuer ? { issuer } : {}),
          ...(sameIssuer && !tokens.refresh_token && prior?.refresh_token
            ? { refresh_token: prior.refresh_token }
            : {}),
        },
        issuedAt: prior?.access_token === tokens.access_token ? before.issuedAt : Date.now(),
      };
    });
  }
  redirectToAuthorization(url: URL) {
    this.authUrl = url;
  }
  async saveCodeVerifier(verifier: string) {
    await this.save({ verifier });
  }
  /**
   * The SDK calls this when the server rejects the saved login, e.g. "Client ID mismatch" on token refresh.
   * Dropping the bad parts makes it start a fresh login, so the page shows "Connect" instead of failing on every load.
   */
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    const drop: Record<typeof scope, (keyof Stored)[]> = {
      all: ["client", "tokens", "verifier", "state", "redirect", "discovery", "issuedAt"],
      client: ["client"],
      tokens: ["tokens", "issuedAt"],
      verifier: ["verifier"],
      discovery: ["discovery"],
    };
    await privateUpdate(`${this.directory}/${this.name}.json`, (input) =>
      Object.fromEntries(
        Object.entries((input as Stored) ?? {}).filter(([key]) => !drop[scope].some((k) => k === key)),
      ),
    );
  }
  async codeVerifier() {
    const { verifier } = await this.load();
    if (!verifier) throw new Error("No code verifier saved");
    return verifier;
  }
}

/** Connects to the server, or says where to sign in. The Mcp service shares the clients (services/mcp.ts). */
async function connectUnshared(
  name: ServerName,
  slackClient: Settings["slackClient"],
  where?: Origins,
): Promise<{ client: Client } | { authUrl: string }> {
  const shared = readOnlyDirectory();
  if (shared && where) throw previewSignInError();
  const provider = new FileProvider(name, slackClient, where, shared);
  const client = new Client({ name: "mondash", version: "0.1.0" });
  try {
    const tokens = shared ? await provider.tokens() : undefined;
    if (shared && !tokens?.access_token)
      throw new UnauthorizedError(`${name} is not connected in the original Mondash`);
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(SERVERS[name]),
        shared
          ? { requestInit: { headers: { Authorization: `Bearer ${tokens!.access_token}` } } }
          : { authProvider: provider },
      ),
    );
    return { client };
  } catch (error) {
    if (error instanceof UnauthorizedError && provider.authUrl) return { authUrl: provider.authUrl.href };
    throw error;
  }
}

const pending = new Map<ServerName, Promise<unknown>>();
/** Serialize OAuth exchange/refresh for MCP and direct API callers sharing the same rotated credentials. */
export async function withOAuthLock<A>(name: ServerName, run: () => Promise<A>): Promise<A> {
  const previous = pending.get(name) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(run);
  pending.set(name, current);
  try {
    return await current;
  } finally {
    if (pending.get(name) === current) pending.delete(name);
  }
}
export const connect = (name: ServerName, client: Settings["slackClient"], where?: Origins) =>
  withOAuthLock(name, () => connectUnshared(name, client, where));

/** Refresh expiring tokens before a direct API call; the SDK retains discovery and issuer validation. */
export const accessToken = (
  name: ServerName,
  client: Settings["slackClient"] = Option.none(),
  rejectedToken?: string,
  options: { directory?: string; fetchFn?: FetchLike; readOnly?: boolean } = {},
) =>
  withOAuthLock(name, async () => {
    const shared = readOnlyDirectory();
    const readOnly = options.readOnly ?? (!options.directory && !!shared);
    const provider = new FileProvider(name, client, origins(Option.none()), options.directory ?? shared);
    const saved = await provider.load();
    if (!saved.tokens) return undefined;
    if (readOnly) {
      if (rejectedToken === saved.tokens.access_token)
        throw new UnauthorizedError("Refresh sign-in in the original Mondash, then retry this preview");
      return saved.tokens.access_token;
    }
    const expired =
      saved.tokens.expires_in !== undefined &&
      (!saved.issuedAt || Date.now() >= saved.issuedAt + saved.tokens.expires_in * 1000 - 60_000);
    if ((rejectedToken === saved.tokens.access_token || expired) && saved.tokens.refresh_token) {
      const result = await auth(provider, { serverUrl: SERVERS[name], fetchFn: options.fetchFn });
      if (result !== "AUTHORIZED") throw new Error(`${name} requires sign-in again`);
    }
    return (await provider.tokens())?.access_token;
  });

export async function hasTokens(name: ServerName) {
  return Boolean(await new FileProvider(name, Option.none(), undefined, readOnlyDirectory()).tokens());
}

async function finishAuthUnshared(
  name: ServerName,
  params: URLSearchParams,
  slackClient: Settings["slackClient"],
  publicUrl: Option.Option<string>,
  port = 3456,
) {
  if (readOnlyDirectory()) throw previewSignInError();
  const { state, redirect } = await new FileProvider(name, slackClient).load();
  if (!state || params.get("state") !== state) throw new Error("OAuth state mismatch");
  // The code is only valid with the return address the sign-in started with.
  const origin = origins(publicUrl, undefined, port).all.find((o) => redirect === callback(o, name));
  if (!origin) throw new Error("OAuth callback address is no longer configured; start sign-in again");
  const provider = new FileProvider(name, slackClient, origins(publicUrl, origin, port));
  await new StreamableHTTPClientTransport(new URL(SERVERS[name]), { authProvider: provider }).finishAuth(params);
  await provider.completeAuthorization();
}

export const finishAuth = (
  name: ServerName,
  params: URLSearchParams,
  client: Settings["slackClient"],
  publicUrl: Option.Option<string>,
  port = 3456,
) => withOAuthLock(name, () => finishAuthUnshared(name, params, client, publicUrl, port));
