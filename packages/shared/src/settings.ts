import { Schema } from "effect";
import { Profile, Integration } from "./setup";
import { HealthResponse } from "./contract";

export const WorkSource = Schema.Literals(["github", "linear", "slack", "notion"]);
export type WorkSource = typeof WorkSource.Type;
export const ScopeOption = Schema.Struct({ id: Schema.String, name: Schema.String });
export const Account = Schema.Struct({
  source: WorkSource,
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  email: Schema.optional(Schema.String),
  login: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
  workspaceId: Schema.optional(Schema.String),
  workspaceKey: Schema.optional(Schema.String),
  options: Schema.Array(ScopeOption),
  complete: Schema.Boolean,
});
export type Account = typeof Account.Type;
export const SettingsResponse = Schema.Struct({
  profile: Profile,
  accounts: Schema.Array(Account),
  health: HealthResponse,
  managed: Schema.Boolean,
  restartRequired: Schema.Boolean,
  available: Schema.Struct({ classification: Schema.Boolean, notifications: Schema.Boolean, tracing: Schema.Boolean }),
});
export type SettingsResponse = typeof SettingsResponse.Type;
export const NotionRole = Schema.Literals([
  "title",
  "status",
  "priority",
  "owner",
  "reviewer",
  "effort",
  "effortDays",
  "created",
  "updated",
]);
export const NotionSelection = Schema.Struct({
  view: Schema.NonEmptyString,
  sourceId: Schema.NonEmptyString,
  fingerprint: Schema.NonEmptyString,
  roles: Schema.Record(NotionRole, Schema.NullOr(Schema.NonEmptyString)),
  stages: Schema.Record(Schema.String, Schema.Literals(["scoping", "open", "review", "ignore"])),
  unusedPeopleRoles: Schema.Array(Schema.Literals(["owner", "reviewer"])),
});
export type NotionSelection = typeof NotionSelection.Type;
export const NotionProposal = Schema.Struct({
  stages: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      selected: Schema.NullOr(Schema.Literals(["scoping", "open", "review", "ignore"])),
    }),
  ),
  view: Schema.NonEmptyString,
  sourceId: Schema.NonEmptyString,
  fingerprint: Schema.NonEmptyString,
  roles: Schema.Array(
    Schema.Struct({ role: NotionRole, selected: Schema.NullOr(Schema.String), candidates: Schema.Array(ScopeOption) }),
  ),
  properties: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String, options: Schema.Array(ScopeOption) }),
  ),
});
export type NotionProposal = typeof NotionProposal.Type;
export const SettingsCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("connect"),
    source: WorkSource,
    organizations: Schema.optional(Schema.Array(Schema.NonEmptyString)),
    personalOnly: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ kind: Schema.Literal("disconnect"), source: WorkSource }),
  Schema.Struct({
    kind: Schema.Literal("scope"),
    organizations: Schema.Array(Schema.NonEmptyString),
    personalOnly: Schema.Boolean,
  }),
  Schema.Struct({ kind: Schema.Literal("feature"), name: Integration, active: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal("notion"), selection: NotionSelection }),
]);
export type SettingsCommand = typeof SettingsCommand.Type;
export const AppliedSettings = Schema.Struct({ restarting: Schema.Boolean });
export const NotionCandidate = Schema.Struct({ id: Schema.String, name: Schema.String, url: Schema.String });
export const NotionCandidates = Schema.Struct({ items: Schema.Array(NotionCandidate), incomplete: Schema.Boolean });
export const NotionInspection = Schema.Struct({
  views: Schema.Array(NotionCandidate),
  warnings: Schema.Array(Schema.String),
  proposal: Schema.NullOr(NotionProposal),
});
