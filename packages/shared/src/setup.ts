import { Schema } from "effect";
const Token = Schema.NonEmptyString.check(Schema.isPattern(/^[\w.-]+$/));
export const Identity = Schema.Struct({
  name: Schema.NonEmptyString,
  email: Schema.optional(Schema.NonEmptyString),
  slack: Schema.optional(Schema.NonEmptyString),
  github: Schema.optional(Schema.NonEmptyString),
  aliases: Schema.optional(Schema.Array(Schema.NonEmptyString)),
});
export const Integration = Schema.Literals([
  "github",
  "linear",
  "slack",
  "notion",
  "sessions",
  "classification",
  "notifications",
  "tracing",
]);
export type Integration = typeof Integration.Type;
export const Profile = Schema.Struct({
  version: Schema.Literal(1),
  directory: Schema.Struct({ me: Schema.String, people: Schema.Array(Identity) }),
  integrations: Schema.Struct({
    github: Schema.Boolean,
    linear: Schema.Boolean,
    slack: Schema.Boolean,
    notion: Schema.Boolean,
    sessions: Schema.Boolean,
    classification: Schema.Boolean,
    notifications: Schema.Boolean,
    tracing: Schema.Boolean,
  }),
  workspace: Schema.Struct({
    organizations: Schema.Array(Token),
    githubPersonalOnly: Schema.optional(Schema.Boolean),
    reviewTeams: Schema.Array(Schema.Struct({ organization: Token, slug: Token })),
    ticketPrefixes: Schema.Array(Schema.String.check(Schema.isPattern(/^[A-Z]{2,6}$/))),
    linearWorkspace: Schema.String,
    directories: Schema.Record(Schema.String, Schema.NonEmptyString),
  }),
  notion: Schema.Struct({
    view: Schema.String,
    sourceId: Schema.optional(Schema.NonEmptyString),
    fingerprint: Schema.optional(Schema.NonEmptyString),
    propertyIds: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(Schema.NonEmptyString))),
    properties: Schema.Struct({
      title: Schema.NonEmptyString,
      status: Schema.NonEmptyString,
      priority: Schema.NullOr(Schema.NonEmptyString),
      owner: Schema.NullOr(Schema.NonEmptyString),
      reviewer: Schema.NullOr(Schema.NonEmptyString),
      effort: Schema.NullOr(Schema.NonEmptyString),
      effortDays: Schema.NullOr(Schema.NonEmptyString),
      created: Schema.NullOr(Schema.NonEmptyString),
      updated: Schema.NullOr(Schema.NonEmptyString),
    }),
    scoping: Schema.Array(Schema.NonEmptyString),
    open: Schema.Array(Schema.NonEmptyString),
    readyToReview: Schema.String,
  }),
  runtime: Schema.Struct({
    host: Schema.NonEmptyString,
    port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
    terminalApp: Schema.NonEmptyString,
    newSessionDir: Schema.NonEmptyString,
    expoGoUrl: Schema.String,
    publicUrl: Schema.String,
  }),
});
export type Profile = typeof Profile.Type;

export const Coverage = Schema.Struct({
  name: Integration,
  enabled: Schema.Boolean,
  configured: Schema.Boolean,
  connected: Schema.Boolean,
  status: Schema.Literals(["disabled", "setup", "pending", "ready", "stale", "error", "unknown", "truncated"]),
  at: Schema.NullOr(Schema.String),
  message: Schema.String,
});
export type Coverage = typeof Coverage.Type;
export const SetupResponse = Schema.Struct({
  profile: Profile,
  activeProfile: Profile,
  restartRequired: Schema.Boolean,
  coverage: Schema.Array(Coverage),
});
export type SetupResponse = typeof SetupResponse.Type;

export const NotionSetupCheck = Schema.Struct({
  columns: Schema.Array(Schema.String),
  missing: Schema.Array(Schema.String),
  statuses: Schema.Array(Schema.String),
  rows: Schema.Finite,
  truncated: Schema.Boolean,
});
export type NotionSetupCheck = typeof NotionSetupCheck.Type;
