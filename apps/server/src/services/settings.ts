import { Context, Effect, Layer, Option, Schema, Semaphore } from "effect";
import {
  Account,
  SettingsResponse,
  type SettingsCommand,
  type WorkSource,
  NotionCandidates,
  NotionInspection,
  type NotionProposal,
} from "@mondash/shared/settings";
import { ServerConfig } from "../config";
import {
  parseNotionDiscovery,
  parseNotionSchema,
  prepareMapping,
  finishMapping,
  notionMappingConfirmation,
  notionSchemaFingerprint,
  type BoardSchema,
} from "../lib/settings-notion";
import { ask } from "../lib/jev";
import { enabled } from "../profile";
import { ConnectionSetup } from "../connection-setup";
import { decodeProfile, identityDirectory, profile, profilePath, readProfile, type Profile } from "../profile";
import { privateUpdate } from "../private-files";
import { ActionFailure } from "./errors";
import { Dashboard } from "./dashboard";
import { Gh } from "./gh";
import { Linear } from "./linear";
import { Mcp } from "./mcp";
import { SlackApi } from "./slack";
import { Store, storeKey } from "./store";

const accountKey = (source: WorkSource) => storeKey(`settings:account:${source}:v1`, Account);
const GitHubUser = Schema.Struct({
  id: Schema.Finite,
  login: Schema.String,
  name: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
});
const GitHubOrgs = Schema.Array(Schema.Struct({ login: Schema.String }));
const SlackSelf = Schema.Struct({ user_id: Schema.String, team_id: Schema.String, team: Schema.String });
const SlackUser = Schema.Struct({
  user: Schema.Struct({
    is_bot: Schema.optional(Schema.Boolean),
    real_name: Schema.optional(Schema.String),
    profile: Schema.Struct({ real_name: Schema.optional(Schema.String), email: Schema.optional(Schema.String) }),
  }),
});
const LinearSelf = Schema.Struct({
  viewer: Schema.Struct({ id: Schema.String, name: Schema.String, email: Schema.String }),
  organization: Schema.Struct({ id: Schema.String, name: Schema.String, urlKey: Schema.String }),
  teams: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, key: Schema.String })),
    pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean }),
  }),
});
const NotionSelf = Schema.fromJsonString(
  Schema.Struct({
    self: Schema.Struct({
      user: Schema.Struct({ id: Schema.String, name: Schema.String, email: Schema.optional(Schema.String) }),
      workspace: Schema.Struct({ id: Schema.String, name: Schema.String }),
    }),
  }),
);
const notionSchemaKey = (view: string) => storeKey(`settings:notion-schema:${view}`, Schema.Unknown);
const fail = (message: string, cause?: unknown) => new ActionFailure({ action: "settings", message, cause });

/** Adds provider-local self identifiers while preserving every confirmed colleague and alias. */
export function withAccount(before: Profile, account: Account): Profile {
  const directory = identityDirectory(before.directory);
  const self = directory.self;
  const field = account.source === "github" ? "github" : account.source === "slack" ? "slack" : undefined;
  const id = account.source === "github" ? account.login : account.source === "slack" ? account.id : undefined;
  if (field && self?.[field] && self[field]?.toLowerCase() !== id?.toLowerCase())
    if (before.integrations[account.source])
      throw new Error("This is a different account. Disconnect the current account before replacing it.");
  const person = {
    ...(self ?? { name: account.name }),
    ...(field && self?.[field] && self[field]?.toLowerCase() !== id?.toLowerCase()
      ? { aliases: [...new Set([...(self.aliases ?? []), self[field]!])] }
      : {}),
    ...(field && id ? { [field]: id } : {}),
    ...(!self?.email && account.email ? { email: account.email } : {}),
    ...(!self && !field && !account.email ? { aliases: [`${account.source}:${account.id}`] } : {}),
  };
  return decodeProfile({
    ...before,
    integrations: { ...before.integrations, [account.source]: true },
    directory: {
      me: before.directory.me || person.email || person.github || person.slack || person.aliases?.[0] || "",
      people: self
        ? before.directory.people.map((p) => (p === self ? person : p))
        : [person, ...before.directory.people],
    },
    workspace:
      account.source === "linear"
        ? {
            ...before.workspace,
            linearWorkspace: account.workspaceKey ?? before.workspace.linearWorkspace,
            ticketPrefixes: [...new Set([...before.workspace.ticketPrefixes, ...account.options.map((o) => o.id)])],
          }
        : before.workspace,
  });
}

function selectedBoard(
  schema: BoardSchema,
  selection: import("@mondash/shared/settings").NotionSelection,
): Profile["notion"] {
  if (!/^view:\/\/[a-f\d-]{32,36}$/i.test(selection.view)) throw new Error("Choose a saved Notion view.");
  const prepared = prepareMapping(schema);
  const candidates = notionMappingConfirmation(schema, finishMapping(schema, prepared, { answers: {} })).roles;
  const properties = Object.fromEntries(
    candidates.map(({ role, candidates }) => {
      const id = selection.roles[role];
      if (id === null) {
        if (role === "title" || role === "status") throw new Error("Choose the title and workflow fields.");
        if (
          (role === "owner" || role === "reviewer") &&
          candidates.length &&
          !selection.unusedPeopleRoles.includes(role)
        )
          throw new Error("Choose your owner and reviewer fields, or explicitly confirm they are unused.");
        return [role, null];
      }
      const property = candidates.find((p) => p.id === id);
      if (!property) throw new Error("A selected field is unavailable or has the wrong type.");
      return [role, property.name];
    }),
  ) as Profile["notion"]["properties"];
  const status = schema.properties.find((p) => p.id === selection.roles.status);
  const options = status?.options ?? [];
  const chosen = Object.keys(selection.stages);
  if (chosen.some((id) => !options.some((o) => o.id === id)) || options.some((o) => !(o.id in selection.stages)))
    throw new Error("Confirm how each workflow status is used.");
  const names = (stage: string) => options.filter((o) => selection.stages[o.id] === stage).map((o) => o.name);
  if (names("review").length !== 1 || !names("scoping").length)
    throw new Error("Choose at least one scoping status and exactly one ready-for-review status.");
  return {
    view: selection.view,
    sourceId: selection.sourceId,
    fingerprint: selection.fingerprint,
    propertyIds: selection.roles,
    properties,
    scoping: names("scoping"),
    open: [...names("scoping"), ...names("open"), ...names("review")],
    readyToReview: names("review")[0],
  };
}

/** A planned helper restart keeps the browser gateway, native window and encrypted endpoint alive. */
export function requestSettingsRestart() {
  if (!process.env.MONDASH_PARENT_PID) return false;
  setTimeout(() => process.exit(75), 750).unref();
  return true;
}

export class SettingsManager extends Context.Service<
  SettingsManager,
  {
    read: Effect.Effect<SettingsResponse, ActionFailure>;
    discover(source: WorkSource): Effect.Effect<Account, ActionFailure>;
    apply(command: SettingsCommand): Effect.Effect<{ restarting: boolean }, ActionFailure>;
    notionSearch(query: string): Effect.Effect<typeof NotionCandidates.Type, ActionFailure>;
    notionInspect(id: string): Effect.Effect<typeof NotionInspection.Type, ActionFailure>;
  }
>()("mondash/server/SettingsManager") {
  static make(path = profilePath(), restart = requestSettingsRestart) {
    return Effect.gen(function* () {
      const gh = yield* Gh;
      const linear = yield* Linear;
      const slack = yield* SlackApi;
      const mcp = yield* Mcp;
      const store = yield* Store;
      const dashboard = yield* Dashboard;
      const config = yield* ServerConfig;
      const discover = Effect.fn("settings.discover")(function* (
        source: WorkSource,
      ): Effect.fn.Return<Account, ActionFailure> {
        const read = Effect.gen(function* () {
          if (source === "github") {
            const self = yield* gh.json(["api", "user"], GitHubUser);
            const orgs = yield* gh
              .json(["api", "user/orgs?per_page=100"], GitHubOrgs)
              .pipe(Effect.orElseSucceed(() => []));
            return {
              source,
              id: String(self.id),
              login: self.login,
              name: self.name || self.login,
              ...(self.email ? { email: self.email } : {}),
              options: orgs.map((o) => ({ id: o.login, name: o.login })),
              complete: orgs.length > 0 && orgs.length < 100,
            };
          }
          if (source === "slack") {
            const self = yield* Schema.decodeUnknownEffect(SlackSelf)(yield* slack.get("auth.test", {}));
            const user = yield* Schema.decodeUnknownEffect(SlackUser)(
              yield* slack.get("users.info", { user: self.user_id }),
            );
            if (user.user.is_bot) return yield* fail("Connect a personal Slack account to show your work.");
            return {
              source,
              id: self.user_id,
              name: user.user.profile.real_name || user.user.real_name || self.user_id,
              ...(user.user.profile.email ? { email: user.user.profile.email } : {}),
              workspace: self.team,
              workspaceId: self.team_id,
              options: [],
              complete: true,
            };
          }
          if (source === "linear") {
            const data = yield* linear.query(
              "query MondashAccount { viewer { id name email } organization { id name urlKey } teams(first:100) { nodes { id name key } pageInfo { hasNextPage } } }",
              {},
              LinearSelf,
            );
            return {
              source,
              id: data.viewer.id,
              name: data.viewer.name,
              email: data.viewer.email,
              workspace: data.organization.name,
              workspaceId: data.organization.id,
              workspaceKey: data.organization.urlKey,
              options: data.teams.nodes.map((t) => ({ id: t.key, name: t.name })),
              complete: !data.teams.pageInfo.hasNextPage,
            };
          }
          const fetched = yield* mcp
            .call("notion", "notion-fetch", { id: "self" })
            .pipe(Effect.orElseSucceed(() => "{}"));
          const self = Schema.decodeUnknownOption(NotionSelf)(fetched);
          if (Option.isSome(self))
            return {
              source,
              id: self.value.self.user.id,
              name: self.value.self.user.name,
              ...(self.value.self.user.email ? { email: self.value.self.user.email } : {}),
              workspace: self.value.self.workspace.name,
              workspaceId: self.value.self.workspace.id,
              options: [],
              complete: true,
            };
          const users = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(
              Schema.Struct({
                results: Schema.Array(
                  Schema.Struct({
                    id: Schema.NonEmptyString,
                    name: Schema.optional(Schema.String),
                    email: Schema.optional(Schema.String),
                    type: Schema.optional(Schema.String),
                  }),
                ),
              }),
            ),
          )(yield* mcp.call("notion", "notion-get-users", { user_id: "self" }));
          const user = users.results.length === 1 ? users.results[0] : undefined;
          if (!user || user.type === "bot")
            return yield* fail("Notion did not identify your personal account. Reconnect on your Mac.");
          return {
            source,
            id: user.id,
            name: user.name || "Notion account",
            ...(user.email ? { email: user.email } : {}),
            options: [],
            complete: true,
          };
        }).pipe(
          Effect.provideService(ConnectionSetup, true),
          Effect.mapError((cause) =>
            cause instanceof ActionFailure
              ? cause
              : fail(
                  source === "github"
                    ? "Sign in to GitHub on this Mac, then try again."
                    : source === "linear"
                      ? "Connect a Linear API key on your Mac to discover your account."
                      : `Could not discover your ${source} account. Connect it on your Mac and retry.`,
                  cause,
                ),
          ),
        );
        const account = yield* Schema.decodeUnknownEffect(Account)(yield* read).pipe(
          Effect.mapError((cause) => fail("Account discovery returned invalid details.", cause)),
        );
        return account;
      });
      const read = Effect.gen(function* () {
        const current = yield* Effect.try({
          try: () => readProfile(path),
          catch: (cause) => fail("Could not read settings on your Mac.", cause),
        });
        const accounts = yield* Effect.forEach(
          ["github", "linear", "slack", "notion"] as const,
          (source) =>
            store.read(accountKey(source)).pipe(
              Effect.flatMap((saved) =>
                saved && Date.now() - saved.at.getTime() < 6 * 60 * 60_000
                  ? Effect.succeed(saved.value)
                  : current.integrations[source]
                    ? discover(source).pipe(
                        Effect.tap((account) => store.write(accountKey(source), account)),
                        Effect.orElseSucceed(() => undefined),
                      )
                    : Effect.succeed(undefined),
              ),
            ),
          { concurrency: 2 },
        );
        const health = yield* dashboard.health;
        return {
          profile: current,
          accounts: accounts.filter((a): a is Account => !!a),
          health,
          managed: !!process.env.MONDASH_PARENT_PID,
          restartRequired: JSON.stringify(current) !== JSON.stringify(profile),
          available: {
            classification: Option.isSome(config.typesafe),
            notifications: Option.isSome(config.ntfy.topic),
            tracing: Option.isSome(config.otlpUrl),
          },
        };
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof ActionFailure
            ? cause
            : fail("Could not read connections. Check your Mac is available.", cause),
        ),
      );
      const updates = Semaphore.makeUnsafe(1);
      let pendingRestart = false;
      const apply = Effect.fn("settings.apply")(function* (command: SettingsCommand) {
        if (restart === requestSettingsRestart && !process.env.MONDASH_PARENT_PID)
          return yield* fail(
            "Open the Mondash Mac app to change settings. This server cannot apply changes automatically.",
          );
        if (pendingRestart) return yield* fail("Mondash is applying settings. Try again shortly.");
        const account = command.kind === "connect" ? yield* discover(command.source) : undefined;
        let selectedNotion: Profile["notion"] | undefined;
        if (command.kind === "notion") {
          const fetched = yield* mcp
            .call("notion", "notion-fetch", { id: `collection://${command.selection.sourceId}` })
            .pipe(
              Effect.provideService(ConnectionSetup, true),
              Effect.mapError((cause) => fail("Could not recheck the board schema.", cause)),
            );
          const parsed = parseNotionSchema(fetched);
          if (!parsed.schema || notionSchemaFingerprint(parsed.schema) !== command.selection.fingerprint)
            return yield* fail("The board changed. Select it again before applying its workflow.");
          const proposal = yield* store
            .read(notionSchemaKey(command.selection.view))
            .pipe(Effect.mapError((cause) => fail("Could not read the selected board.", cause)));
          if (!proposal || parseNotionSchema(proposal.value).schema?.id !== parsed.schema.id)
            return yield* fail("Choose a saved board view before applying it.");
          selectedNotion = yield* Effect.try({
            try: () => selectedBoard(parsed.schema!, command.selection),
            catch: (cause) => fail(cause instanceof Error ? cause.message : "Invalid workflow", cause),
          });
        }
        yield* Effect.tryPromise({
          try: () =>
            privateUpdate(path, (input) => {
              const before = input ? decodeProfile(input) : readProfile(path);
              if (command.kind === "connect" && account) {
                const next = withAccount(before, account);
                if (command.source !== "github") return next;
                const organizations = command.organizations ?? before.workspace.organizations;
                const personalOnly = command.personalOnly ?? before.workspace.githubPersonalOnly ?? false;
                if (!organizations.length && !personalOnly && !before.integrations.github)
                  throw new Error("Choose an organization or personal repositories before connecting GitHub.");
                return decodeProfile({
                  ...next,
                  workspace: {
                    ...next.workspace,
                    organizations,
                    githubPersonalOnly: personalOnly,
                    reviewTeams: next.workspace.reviewTeams.filter((t) => organizations.includes(t.organization)),
                  },
                });
              }
              if (command.kind === "disconnect")
                return decodeProfile({ ...before, integrations: { ...before.integrations, [command.source]: false } });
              if (command.kind === "scope") {
                if (!command.organizations.length && !command.personalOnly)
                  throw new Error("Choose an organization or personal repositories.");
                return decodeProfile({
                  ...before,
                  workspace: {
                    ...before.workspace,
                    organizations: command.organizations,
                    githubPersonalOnly: command.personalOnly,
                    reviewTeams: before.workspace.reviewTeams.filter((t) =>
                      command.organizations.includes(t.organization),
                    ),
                  },
                });
              }
              if (command.kind === "feature") {
                const configured =
                  command.name === "classification"
                    ? Option.isSome(config.typesafe)
                    : command.name === "notifications"
                      ? Option.isSome(config.ntfy.topic)
                      : command.name === "tracing"
                        ? Option.isSome(config.otlpUrl)
                        : command.name === "sessions";
                if (command.active && !configured)
                  throw new Error("Configure this feature on your Mac before turning it on.");
                return decodeProfile({
                  ...before,
                  integrations: { ...before.integrations, [command.name]: command.active },
                });
              }
              if (command.kind === "notion")
                return decodeProfile({
                  ...before,
                  integrations: { ...before.integrations, notion: true },
                  notion: selectedNotion,
                });
              throw new Error("Unsupported settings change");
            }),
          catch: (cause) => fail(cause instanceof Error ? cause.message : "Could not apply settings.", cause),
        });
        // Only work changes invalidate work. Consent/preferences for diagnostics leave provider snapshots intact.
        const workChange =
          command.kind !== "feature" || command.name === "sessions" || command.name === "classification";
        const source =
          command.kind === "connect" || command.kind === "disconnect"
            ? command.source
            : command.kind === "scope"
              ? "github"
              : command.kind === "notion"
                ? "notion"
                : undefined;
        const raw =
          source === "github"
            ? ["github:my-open-prs:", "github:my-other-prs:", "github:my-merged-prs:", "github:events:", "feed:github"]
            : source === "linear"
              ? ["linear:"]
              : source === "slack"
                ? ["slack:", "slack-threads:", "mcp:slack:", "feed:slack:"]
                : source === "notion"
                  ? ["mcp:notion:", "roadmap:"]
                  : [];
        const prefixes = workChange
          ? ["resume:", "github:review-feed:", "feed:v", "triage:", "live:", "jev-", ...raw]
          : [];
        yield* Effect.forEach(prefixes, (prefix) => store.forgetPrefix(prefix), { discard: true }).pipe(
          Effect.mapError((cause) => fail("Settings saved, but refresh could not start. Reopen Mondash.", cause)),
        );
        if (account)
          yield* store
            .write(accountKey(account.source), account)
            .pipe(Effect.mapError((cause) => fail("Could not save account details.", cause)));
        if (command.kind === "disconnect")
          yield* store
            .forget(accountKey(command.source).name)
            .pipe(Effect.mapError((cause) => fail("Could not remove account details.", cause)));
        const restarting = restart();
        pendingRestart = restarting;
        return { restarting };
      }, updates.withPermit);
      const notionSearch = Effect.fn("settings.notionSearch")(
        function* (query: string) {
          if (!query.trim()) return yield* fail("Enter a board or roadmap name to search Notion.");
          const access = yield* mcp.cachedCall("notion", "notion-get-tool-access", {}, "15 minutes").pipe(
            Effect.provideService(ConnectionSetup, true),
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.fromJsonString(
                  Schema.Struct({
                    current_tool_access: Schema.Struct({
                      ai_search: Schema.optional(Schema.Struct({ status: Schema.String })),
                      search: Schema.optional(Schema.Struct({ status: Schema.String })),
                    }),
                  }),
                ),
              ),
            ),
          );
          const ai = access.current_tool_access.ai_search?.status === "available";
          if (!ai && access.current_tool_access.search?.status !== "available")
            return yield* fail(
              "This Notion account does not provide content search. Browse your current board or reconnect on your Mac.",
            );
          const response = yield* mcp
            .call(
              "notion",
              ai ? "notion-ai-search" : "notion-search",
              ai
                ? { query: query.trim(), page_size: 50, max_highlight_length: 0 }
                : { query: query.trim(), page_size: 50 },
            )
            .pipe(Effect.provideService(ConnectionSetup, true));
          const result = parseNotionDiscovery(response);
          if (!result.items.length && result.warnings.length) return yield* fail(result.warnings[0]);
          return {
            items: result.items.map((r) => ({
              id: r.kind === "view" || r.kind === "data_source" ? r.url : r.id,
              name: r.name,
              url: r.url,
            })),
            incomplete: result.incomplete || result.items.length >= 50,
          };
        },
        Effect.mapError((cause) =>
          cause instanceof ActionFailure
            ? cause
            : fail("Could not browse Notion. Connect it and share the board with your account.", cause),
        ),
      );
      const notionInspect = Effect.fn("settings.notionInspect")(
        function* (id: string) {
          const response = yield* mcp
            .call("notion", "notion-fetch", { id })
            .pipe(Effect.provideService(ConnectionSetup, true));
          const discovery = parseNotionDiscovery(response);
          const views = discovery.items
            .filter((r) => r.kind === "view" || r.kind === "database")
            .map((r) => ({ id: r.url, name: r.name, url: r.url }));
          if (!id.startsWith("view://")) {
            const availableChildren = discovery.items.filter((r) => r.kind === "database");
            const children = availableChildren.slice(0, 5);
            const boards = yield* Effect.forEach(
              children,
              (child) =>
                mcp.call("notion", "notion-fetch", { id: child.id }).pipe(
                  Effect.provideService(ConnectionSetup, true),
                  Effect.flatMap(
                    Schema.decodeUnknownEffect(
                      Schema.fromJsonString(
                        Schema.Struct({
                          metadata: Schema.Struct({ type: Schema.Literal("database") }),
                          title: Schema.NonEmptyString,
                        }),
                      ),
                    ),
                  ),
                  Effect.map((result) => ({ id: child.id, url: child.url, name: result.title })),
                  Effect.orElseSucceed(() => undefined),
                ),
              { concurrency: 2 },
            );
            const candidates = [
              ...views.filter((v) => v.id.startsWith("view://")),
              ...boards.filter((b): b is NonNullable<typeof b> => !!b),
            ];
            return {
              views: candidates,
              warnings: [
                ...discovery.warnings,
                ...(discovery.incomplete || availableChildren.length > children.length
                  ? ["More boards may be available. Refine your search to find yours."]
                  : []),
                ...(boards.some((b) => !b)
                  ? ["Some boards could not be checked. Try again or search for the board by name."]
                  : []),
                ...(!candidates.length ? ["This item has no saved board views available to this connection."] : []),
              ],
              proposal: null,
            };
          }
          // Inspect the view and its explicit source. Never substitute a whole database query for view membership.
          const source = discovery.items.find((r) => r.kind === "data_source");
          if (!source)
            return {
              views: [],
              warnings: [
                "The connection did not expose this view’s data source. Select its original database and retry.",
              ],
              proposal: null,
            };
          const schemaResponse = yield* mcp
            .call("notion", "notion-fetch", { id: source.url })
            .pipe(Effect.provideService(ConnectionSetup, true));
          const parsed = parseNotionSchema(schemaResponse);
          if (!parsed.schema)
            return {
              views: [],
              warnings: [
                "This Notion connection did not return a supported board schema. Your existing board settings are retained.",
              ],
              proposal: null,
            };
          const schema = parsed.schema;
          if (schema.id.replaceAll("-", "").toLowerCase() !== source.id.replaceAll("-", "").toLowerCase())
            return yield* fail("Notion returned a different data source for this view. Select the board again.");
          const prepared = prepareMapping(schema);
          const answer =
            enabled("classification") && Option.isSome(config.typesafe)
              ? yield* ask(prepared.request.state, prepared.request.questions).pipe(
                  Effect.provideService(ServerConfig, config),
                  Effect.timeout("10 seconds"),
                  Effect.orElseSucceed(() => ({ answers: {} })),
                )
              : { answers: {} };
          const mapping = finishMapping(schema, prepared, answer);
          const confirmed = notionMappingConfirmation(schema, mapping);
          yield* store
            .write(notionSchemaKey(id), JSON.parse(schemaResponse))
            .pipe(Effect.mapError((cause) => fail("Could not retain the board schema.", cause)));
          return {
            views: [],
            warnings: discovery.warnings,
            proposal: {
              view: id,
              sourceId: schema.id,
              fingerprint: confirmed.fingerprint,
              stages: confirmed.stages.map((s): NotionProposal["stages"][number] => ({
                id: s.optionId,
                selected:
                  s.decision.value === "done"
                    ? "ignore"
                    : s.decision.value === "scoping"
                      ? "scoping"
                      : s.decision.value === "review"
                        ? "review"
                        : s.decision.value === "open"
                          ? "open"
                          : null,
              })),
              roles: confirmed.roles.map((r) => ({
                role: r.role,
                selected: r.decision.value,
                candidates: r.candidates.map((p) => ({ id: p.id, name: p.name })),
              })),
              properties: schema.properties.map((p) => ({
                id: p.id,
                name: p.name,
                options: (p.options ?? []).map((o) => ({ id: o.id, name: o.name })),
              })),
            },
          };
        },
        Effect.mapError((cause) =>
          cause instanceof ActionFailure
            ? cause
            : fail("Could not inspect this board. Share its original database with the connection and retry.", cause),
        ),
      );
      return SettingsManager.of({ read, discover, apply, notionSearch, notionInspect });
    });
  }
  static readonly layer = Layer.effect(SettingsManager, SettingsManager.make());
}
