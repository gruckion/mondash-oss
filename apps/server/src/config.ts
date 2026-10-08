import { profile } from "./profile";
import { Config, Context, Effect, Layer, Option, type Redacted } from "effect";

/** Every setting the server reads, from `.env` (Bun loads it) or the launch agent's environment. */
export interface Settings {
  readonly host: string;
  readonly port: number;
  /** Expo Go on the phone loads the app from Metro at this address. */
  readonly expoGoUrl: string;
  /** Phone alerts through ntfy: nothing is sent until a topic is set. The topic is the only secret. */
  readonly ntfy: { readonly topic: Option.Option<Redacted.Redacted>; readonly server: string };
  /** Slack Socket Mode, for DMs that arrive live. Without it the Slack data refreshes on a timer only. */
  readonly slackAppToken: Option.Option<Redacted.Redacted>;
  /** A Linear personal API key: the dashboard reads and links tickets through Linear's GraphQL API with it. */
  readonly linearApiKey: Option.Option<Redacted.Redacted>;
  /** The pre-registered Slack app for MCP sign-in; Slack has no dynamic client registration. */
  readonly slackClient: Option.Option<{ readonly id: string; readonly secret: Redacted.Redacted }>;
  /** Jev (TypeSafe), which classifies work context. */
  readonly typesafe: Option.Option<{ readonly apiKey: Redacted.Redacted; readonly model: string }>;
  /** The terminal app that resumes a Claude Code session on the Mac. */
  readonly terminalApp: string;
  /** Overrides where the Claude Code executable is. */
  readonly claudeBin: Option.Option<string>;
  /** Where the Sessions tab's "New Claude session" starts. */
  readonly newSessionDir: string;
  /** Where traces go, such as a local Jaeger at http://127.0.0.1:4318. Without it, nothing is exported. */
  readonly otlpUrl: Option.Option<string>;
  /** The Mac's address from the phone (the tailnet URL), so an MCP sign-in started on the phone can come back. */
  readonly publicUrl: Option.Option<string>;
}

const settings = Config.all({
  host: Config.String("MONDASH_HOST").pipe(Config.withDefault(profile.runtime.host)),
  port: Config.Port("MONDASH_PORT").pipe(Config.withDefault(profile.runtime.port)),
  expoGoUrl: Config.String("MONDASH_EXPO_GO_URL").pipe(Config.withDefault(profile.runtime.expoGoUrl)),
  ntfy: Config.all({
    topic: Config.Redacted("NTFY_TOPIC").pipe(Config.option),
    server: Config.String("NTFY_SERVER").pipe(Config.withDefault("https://ntfy.sh")),
  }),
  slackAppToken: Config.Redacted("SLACK_APP_TOKEN").pipe(Config.option),
  linearApiKey: Config.Redacted("LINEAR_API_KEY").pipe(Config.option),
  slackClient: Config.all({
    id: Config.String("SLACK_CLIENT_ID"),
    secret: Config.Redacted("SLACK_CLIENT_SECRET"),
  }).pipe(Config.option),
  typesafe: Config.all({ apiKey: Config.Redacted("TYPESAFE_API_KEY"), model: Config.String("TYPESAFE_MODEL") }).pipe(
    Config.option,
  ),
  terminalApp: Config.String("TERMINAL_APP").pipe(Config.withDefault(profile.runtime.terminalApp)),
  claudeBin: Config.String("MONDASH_CLAUDE_BIN").pipe(Config.option),
  newSessionDir: Config.String("MONDASH_NEW_SESSION_DIR").pipe(Config.withDefault(profile.runtime.newSessionDir)),
  otlpUrl: Config.String("OTEL_EXPORTER_OTLP_ENDPOINT").pipe(Config.option),
  publicUrl: Config.String("MONDASH_PUBLIC_URL").pipe(Config.withDefault(profile.runtime.publicUrl), Config.option),
});

/** The server's settings, read and checked once when the server starts. A bad value stops the start with its name. */
export class ServerConfig extends Context.Service<ServerConfig, Settings>()("mondash/server/ServerConfig") {
  static readonly layer = Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const resolved = yield* settings;
      return ServerConfig.of({ ...resolved, publicUrl: Option.filter(resolved.publicUrl, (value) => !!value) });
    }),
  );
}
