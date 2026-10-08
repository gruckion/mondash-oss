import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { ServerConfig } from "@/config";
import { LiveLayer } from "@/live";
import { Claude } from "@/services/claude";
import { AgentAuth } from "@/services/agent-auth";
import { Debriefs } from "@/services/debriefs";
import { Dashboard } from "@/services/dashboard";
import { DesktopLinks } from "@/services/desktop-links";
import { Gh } from "@/services/gh";
import { Inbox } from "@/services/inbox";
import { Linear } from "@/services/linear";
import { Mcp } from "@/services/mcp";
import { Reviews } from "@/services/reviews";
import { Sessions } from "@/services/sessions";
import { SlackApi } from "@/services/slack";
import { Store } from "@/services/store";
import { Tickets } from "@/services/tickets";
import { SettingsManager } from "@/services/settings";
import { Tracing } from "@/tracing";
import { Routes, UntracedRequests } from "./http";

// The store, the provider clients and Claude Code, which the services below are built on.
const Clients = SlackApi.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(Mcp.layer, Gh.layer, Claude.layer, Linear.layer, AgentAuth.layer)),
  Layer.provideMerge(Store.layer),
);

const Services = Layer.mergeAll(
  Debriefs.layer,
  Dashboard.layer,
  DesktopLinks.layer,
  Inbox.layer,
  Reviews.layer,
  Sessions.layer,
  Tickets.layer,
).pipe(Layer.provideMerge(Clients));
const AppServices = SettingsManager.layer.pipe(Layer.provideMerge(Services));

// Tailscale serve forwards the tailnet's HTTPS port here; nothing else should reach it.
const HttpServer = Layer.unwrap(
  Effect.gen(function* () {
    const { host, port } = yield* ServerConfig;
    // Provider calls and the client have deadlines; Jev batch waves and SSE can be quiet for longer than Bun’s default idle limit.
    return BunHttpServer.layer({ hostname: host, port, idleTimeout: 0 });
  }),
);

// The Slack websocket and the change checks run for as long as the server does.
const Server = Layer.mergeAll(
  HttpRouter.serve(Routes, { disableLogger: true }).pipe(Layer.provide([HttpServer, UntracedRequests])),
  process.env.MONDASH_READ_ONLY === "1" ? Layer.empty : LiveLayer,
).pipe(Layer.provide(AppServices), Layer.provide(Tracing), Layer.provide(ServerConfig.layer));

Layer.launch(Server).pipe(BunRuntime.runMain);
