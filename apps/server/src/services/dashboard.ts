import { coverage } from "../coverage";
import { ServerConfig as RuntimeConfig } from "../config";
import { enabled } from "../profile";
import { Clock, Context, DateTime, Duration, Effect, Layer, Schema } from "effect";
import { type Connection, type HealthResponse, SectionName, SectionResponse } from "@mondash/shared/contract";
import type { ServerConfig } from "@/config";
import { getTriage, slackSearchFreshness } from "@/lib/feed";
import { PRS_KEY } from "@/lib/github";
import { MINE_KEY } from "@/lib/linear-api";
import { ROADMAP_KEY } from "@/lib/notion";
import type { ServerName } from "@/lib/mcp";
import { connectionState } from "@/lib/presenters";
import { findUnlinkedThreads, RESUME_KEY } from "@/lib/resume";
import { loadSection } from "@/lib/sections";
import { AgentAuth } from "./agent-auth";
import { RECENT_KEY } from "@/lib/sessions";
import { makeThreadDiscovery } from "@/lib/thread-discovery";
import type { Claude } from "./claude";
import { SourceFailure } from "./errors";
import { GITHUB_HEALTH_KEY, Gh } from "./gh";
import { Linear } from "./linear";
import { Mcp } from "./mcp";
import type { SlackApi } from "./slack";
import { ReadOnly, Store, storeKey } from "./store";

// With no request for this long nobody is looking, so the sections refresh every IDLE_EVERY instead of every minute.
const ACTIVE_FOR = Duration.toMillis(Duration.minutes(5));
const IDLE_EVERY = Duration.toMillis(Duration.minutes(15));

/** Whether the minute tick should refresh the sections: always while someone looks, else every 15 minutes. */
export const warmDue = (now: number, askedAt: number, warmedAt: number) =>
  now - askedAt <= ACTIVE_FOR || now - warmedAt >= IDLE_EVERY;

/** The dashboard's sections and the state of each connection, as the app shows them. */
export class Dashboard extends Context.Service<
  Dashboard,
  {
    /** A section from the store, with no provider call unless it was never built. */
    section(name: SectionName): Effect.Effect<SectionResponse, SourceFailure>;
    health: Effect.Effect<HealthResponse, SourceFailure>;
    /**
     * Refreshes every section, the Saved-in-Slack verdicts and the Slack thread search: run each minute by live.ts.
     * While nobody has asked for a section in 5 minutes it refreshes at most every 15 minutes.
     */
    readonly warm: Effect.Effect<void>;
  }
>()("mondash/server/Dashboard") {
  static readonly layer = Layer.effect(
    Dashboard,
    Effect.gen(function* () {
      const settings = yield* RuntimeConfig;
      const store = yield* Store;
      const mcp = yield* Mcp;
      const linear = yield* Linear;
      const agents = yield* AgentAuth;
      const gh = yield* Gh;
      const context = yield* Effect.context<Store | Mcp | Gh | SlackApi | Claude | ServerConfig | Linear>();
      const threads = yield* makeThreadDiscovery(findUnlinkedThreads);

      // Share bounded provider probes briefly; agent login is checked afresh even immediately after reauthentication.
      const probes = yield* Effect.cachedWithTTL(
        Effect.all(
          [
            (enabled("linear") && linear.connected
              ? linear.query(
                  "query { viewer { id } }",
                  {},
                  Schema.Struct({ viewer: Schema.Struct({ id: Schema.String }) }),
                )
              : Effect.void
            ).pipe(Effect.timeout("8 seconds"), Effect.result),
            (enabled("github") ? gh.json(["api", "user"], Schema.Struct({ id: Schema.Number })) : Effect.void).pipe(
              Effect.timeout("8 seconds"),
              Effect.result,
            ),
            Effect.forEach(
              ["slack", "notion"] as const,
              (name) =>
                enabled(name)
                  ? mcp.hasTokens(name).pipe(Effect.flatMap((tokens) => (tokens ? mcp.probe(name) : Effect.void)))
                  : Effect.void,
              { concurrency: "unbounded", discard: true },
            ),
          ],
          { concurrency: "unbounded" },
        ),
        "15 seconds",
      );
      const connections = Effect.gen(function* () {
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        const [[linearProbe, githubProbe], agentConnections] = yield* Effect.all(
          [probes, enabled("sessions") ? agents.health : Effect.succeed([])],
          {
            concurrency: "unbounded",
          },
        );
        // Linear goes through its API with a key; Slack and Notion through their MCP sign-ins.
        const linearConnection: Connection =
          linearProbe._tag === "Failure"
            ? {
                name: "linear",
                state: "error",
                checkedAt,
                message: "Linear could not be reached or refused its login.",
              }
            : connectionState("linear", linear.connected, yield* linear.health);
        const servers: ServerName[] = ["slack", "notion"];
        const mcpConnections = yield* Effect.forEach(
          servers,
          (name) =>
            Effect.all([enabled(name) ? mcp.hasTokens(name) : Effect.succeed(false), mcp.health(name)]).pipe(
              Effect.map(([tokens, health]) => connectionState(name, tokens, health)),
            ),
          { concurrency: "unbounded" },
        );
        // The MCP health covers MCP calls only; the Inbox's Slack searches go through the Web API.
        const slackFreshness = yield* slackSearchFreshness.pipe(Effect.provideService(Store, store));
        const githubHealth = (yield* store.read(GITHUB_HEALTH_KEY))?.value;
        const githubAt = yield* store.storedAt(PRS_KEY.name);
        const githubConnection: Connection =
          githubProbe._tag === "Failure"
            ? {
                name: "github",
                state: "error",
                checkedAt,
                message: "GitHub could not be reached or refused its login.",
              }
            : connectionState("github", !!githubHealth || !!githubAt, githubHealth);
        const sessionsAt = enabled("sessions") ? yield* store.storedAt(RECENT_KEY.name) : undefined;
        const sessionsConnection: Connection = {
          name: "sessions",
          state: sessionsAt ? "connected" : "unknown",
          checkedAt: sessionsAt?.toISOString() ?? null,
          lastSyncedAt: sessionsAt?.toISOString() ?? null,
        };
        return yield* Effect.forEach(
          [linearConnection, ...mcpConnections, githubConnection, sessionsConnection, ...agentConnections],
          (connection) =>
            Effect.gen(function* () {
              const key =
                connection.name === "linear"
                  ? MINE_KEY.name
                  : connection.name === "notion"
                    ? ROADMAP_KEY.name
                    : connection.name === "github"
                      ? PRS_KEY.name
                      : undefined;
              const at = key ? yield* store.storedAt(key) : undefined;
              return {
                ...connection,
                ...(connection.name === "slack"
                  ? slackFreshness
                  : { lastSyncedAt: key ? (at?.toISOString() ?? null) : (connection.lastSyncedAt ?? null) }),
              } satisfies Connection;
            }),
          { concurrency: "unbounded" },
        );
      });

      const scope = yield* Effect.scope;
      let askedAt = 0;
      let warmedAt = 0;
      const warmAll = Effect.gen(function* () {
        warmedAt = yield* Clock.currentTimeMillis;
        yield* Effect.all(
          [
            Effect.forEach(
              SectionName.literals,
              (name) =>
                loadSection(name, threads.snapshot).pipe(
                  Effect.catchCause((cause) => Effect.logWarning(`Refreshing the ${name} section failed`, cause)),
                ),
              { concurrency: "unbounded", discard: true },
            ),
            // Not a section: the Inbox reads these verdicts on its saved Slack items.
            (enabled("slack") ? getTriage() : Effect.succeed([])).pipe(
              Effect.catchCause((cause) => Effect.logWarning("Refreshing the saved-item verdicts failed", cause)),
            ),
          ],
          { concurrency: "unbounded", discard: true },
        );
        // After Issues, so the search is for the tickets just stored. It runs in the background.
        yield* store.read(RESUME_KEY).pipe(
          Effect.flatMap((resume) =>
            enabled("slack") && enabled("linear") && resume
              ? threads.refresh(resume.value.sections.flatMap((group) => group.tickets))
              : Effect.void,
          ),
          Effect.catchCause((cause) => Effect.logWarning("Starting the Slack thread search failed", cause)),
        );
      }).pipe(Effect.provideContext(context), Effect.withSpan("Dashboard.warm"));

      return Dashboard.of({
        warm: Effect.gen(function* () {
          if (warmDue(yield* Clock.currentTimeMillis, askedAt, warmedAt)) yield* warmAll;
        }),
        section: (name) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            // The first look after a quiet spell refreshes now rather than at the next idle tick.
            if (
              process.env.MONDASH_READ_ONLY !== "1" &&
              now - askedAt > ACTIVE_FOR &&
              now - warmedAt >= Duration.toMillis(Duration.minutes(1))
            )
              yield* Effect.forkIn(warmAll, scope);
            askedAt = now;
            const section = yield* loadSection(name, threads.snapshot).pipe(Effect.provideService(ReadOnly, true));
            const truncated = (yield* store.read(storeKey("coverage:notion-truncated", Schema.Boolean)))?.value;
            const githubTruncated = (yield* Effect.forEach(["mine", "other-prs", "reviews"], (part) =>
              store.read(storeKey(`coverage:github-${part}-truncated`, Schema.Boolean)),
            )).some((entry) => entry?.value);
            return {
              ...section,
              coverage: coverage(yield* connections, settings)
                .filter((source) => ["github", "linear", "slack", "notion", "sessions"].includes(source.name))
                .map((source) =>
                  source.name === "github" && source.enabled && githubTruncated
                    ? {
                        ...source,
                        status: "truncated" as const,
                        message:
                          "GitHub search exceeds its search ceiling or a fetched page (25 requested/team/reviewed, 60 broad; authored open, merged and closed PRs are paginated). Some work has not been checked; narrow organization scope or inspect GitHub directly.",
                      }
                    : source.name === "notion" && source.enabled && truncated
                      ? {
                          ...source,
                          status: "truncated" as const,
                          message:
                            "The saved view may contain more than 100 rows. Narrow the view; remaining work has not been checked.",
                        }
                      : source,
                ),
            };
          }).pipe(
            Effect.provideContext(context),
            Effect.mapError((cause) => new SourceFailure({ source: name, cause })),
            // A section that breaks the contract would otherwise leave as a bare 400 with nothing in the log.
            Effect.tap((section) =>
              Schema.encodeEffect(SectionResponse)(section).pipe(
                Effect.mapError((cause) => new SourceFailure({ source: name, cause })),
              ),
            ),
            Effect.withSpan("Dashboard.section", { attributes: { section: name } }),
          ),
        health: connections.pipe(
          Effect.mapError((cause) => new SourceFailure({ source: "health", cause })),
          Effect.flatMap((list) =>
            Effect.map(DateTime.now, (now): HealthResponse => ({
              version: 1,
              name: "Mondash",
              at: DateTime.formatIso(now),
              connections: list,
            })),
          ),
          Effect.withSpan("Dashboard.health"),
        ),
      });
    }),
  );
}
