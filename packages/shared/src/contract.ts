import { Coverage } from "./setup";
import { Effect, Schema } from "effect";

// What the Mac sends the app: no provider tokens, raw MCP payloads or local file paths.

// Strings on the wire and in the app: the checks make sure they parse, without a decoded URL or DateTime to convert back.
const WebUrl = Schema.String.check(
  Schema.isPattern(/^https:\/\/\S+$/),
  Schema.makeFilter((value) => URL.canParse(value)),
);
const IsoDate = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/),
  Schema.makeFilter((value) => !Number.isNaN(Date.parse(value))),
);
/** Jev's confidence, 0 to 1. */
const Chance = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const optional = Schema.optional;
/**
 * A display-only value the Mac may know more of than the phone. An unknown one decodes to `fallback`, so a newer Mac
 * shows a plain value instead of failing the whole section. Encoding still rejects it.
 */
const display = <const L extends ReadonlyArray<string>>(literals: L, fallback: L[number]) =>
  Schema.Literals(literals).pipe(Schema.catchDecoding<Schema.Literals<L>>(() => Effect.succeedSome(fallback)));
/** An optional display-only value: an unknown one decodes as absent. */
const optionalDisplay = <const L extends ReadonlyArray<string>>(literals: L) =>
  optional(Schema.Literals(literals).pipe(Schema.catchDecoding<Schema.Literals<L>>(() => Effect.succeedNone)));

export const SectionName = Schema.Literals(["issues", "scoping", "reviews", "sessions", "inbox"]);
export type SectionName = typeof SectionName.Type;

export const Link = Schema.Struct({ title: Schema.String, url: WebUrl });

export const SessionPRStatus = Schema.Struct({
  url: WebUrl,
  title: Schema.String,
  state: optionalDisplay(["OPEN", "DRAFT", "MERGED", "CLOSED"]),
});
export type SessionPRStatus = typeof SessionPRStatus.Type;

/** Latest context occupancy, never cumulative usage across requests. */
export const SessionContextUsage = Schema.Struct({
  usedTokens: Count,
  windowTokens: optional(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type SessionContextUsage = typeof SessionContextUsage.Type;

export const Session = Schema.Struct({
  id: Schema.String,
  tool: Schema.Literals(["claude", "codex"]),
  title: Schema.String,
  updatedAt: IsoDate,
  canOpenOnMac: Schema.Boolean,
  canOpenInClaude: optional(Schema.Boolean),
  canOpenInChatGPT: optional(Schema.Boolean),
  preview: optional(Schema.String.check(Schema.isMaxLength(1200))),
  previewKind: optionalDisplay(["recap", "response"]),
  /** Jev's chance this session is work on its item; absent in the Sessions list and direct user launches. */
  jev: optional(Chance),
  /** The provider’s native archive state; absent when the provider has no matching record. */
  archived: optional(Schema.Boolean),
  /** A native archive action is available for this session. */
  canArchive: optional(Schema.Boolean),
  /** Explicit provider turn lifecycle state, when available. */
  running: optional(Schema.Boolean),
  contextUsage: optional(SessionContextUsage),
  /** Associated PRs with known provider status, for the session sidebar. */
  pullRequests: optional(Schema.Array(SessionPRStatus)),
});
export type Session = typeof Session.Type;

/** Transcript attachment identity; the client never supplies a local path. */
export const ConversationAttachment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["image", "file"]),
  /** A Markdown reference opens this attachment from the message body. */
  inline: optional(Schema.Boolean),
  /** Project-relative display path and source location, when this is a local file. */
  path: optional(Schema.String),
  line: optional(Schema.Int),
});
export type ConversationAttachment = typeof ConversationAttachment.Type;

export const SessionAttachment = Schema.Struct({
  name: Schema.String,
  mediaType: Schema.String,
  /** Base64 bytes, loaded separately from messages. */
  data: Schema.String,
});
export type SessionAttachment = typeof SessionAttachment.Type;

export const SessionFiles = Schema.Struct({
  root: Schema.String,
  files: Schema.Array(ConversationAttachment),
  truncated: Schema.Boolean,
});
export type SessionFiles = typeof SessionFiles.Type;

export const ConversationEdit = Schema.Struct({
  file: ConversationAttachment,
  diff: Schema.String,
  additions: Schema.Int,
  deletions: Schema.Int,
});
export type ConversationEdit = typeof ConversationEdit.Type;

export const ConversationActivity = Schema.Struct({
  id: Schema.String,
  label: optional(Schema.String),
  name: Schema.String,
  input: Schema.String,
  output: optional(Schema.String),
  status: Schema.Literals(["running", "completed", "failed", "interrupted"]),
});

/** A message or an expandable tool activity, in transcript order. */
export const ConversationTurn = Schema.Struct({
  id: optional(Schema.String),
  role: Schema.Literals(["user", "assistant"]),
  /** Provider-marked progress and final responses; absent for older/unclassified messages. */
  phase: optionalDisplay(["commentary", "final"]),
  /** Visible initialization context, distinguished from a person's prompt. */
  context: optional(Schema.String),
  text: Schema.String,
  at: optional(IsoDate),
  activity: optional(ConversationActivity),
  attachments: optional(Schema.Array(ConversationAttachment)),
  edits: optional(Schema.Array(ConversationEdit)),
});
export type ConversationTurn = typeof ConversationTurn.Type;

/** Recent display messages and project context; model reasoning is excluded. */
export const SessionConversation = Schema.Struct({
  tool: Schema.Literals(["claude", "codex"]),
  id: Schema.String,
  title: Schema.String,
  turns: Schema.Array(ConversationTurn),
  running: optional(Schema.Boolean),
  /** Older turns were left out. */
  truncated: Schema.Boolean,
});
export type SessionConversation = typeof SessionConversation.Type;

export const Person = Schema.Struct({ name: Schema.String, avatar: optional(WebUrl) });
export type Person = typeof Person.Type;

export const Badge = Schema.Struct({
  text: Schema.String,
  tone: display(["amber", "violet", "sky", "green", "red", "neutral"], "neutral"),
  url: optional(WebUrl),
  people: optional(Schema.Array(Person)),
  /** Jev's confidence behind this badge, shown with its face. */
  jev: optional(Chance),
});
export type Badge = typeof Badge.Type;

export const PRState = Schema.Literals(["OPEN", "DRAFT", "MERGED", "CLOSED"]);
export type PRState = typeof PRState.Type;

export const ChecksSummary = Schema.Struct({
  passed: Count,
  failed: Count,
  pending: Count,
  skipped: Count,
  cancelled: optional(Count),
});
export type ChecksSummary = typeof ChecksSummary.Type;

/** The complete PR diff, rather than the last commit or a paginated file list. */
export const PRChanges = Schema.Struct({ additions: Count, deletions: Count, files: Count });
export type PRChanges = typeof PRChanges.Type;

/** PRs referenced by a session, loaded independently of its transcript. Missing metadata stays unknown. */
export const SessionPullRequest = Schema.Struct({
  url: WebUrl,
  repo: Schema.String,
  number: Count,
  title: optional(Schema.String),
  branch: optional(Schema.String),
  state: optionalDisplay(["OPEN", "DRAFT", "MERGED", "CLOSED"]),
  author: optional(Person),
  updatedAt: optional(IsoDate),
  changes: optional(PRChanges),
  checks: optional(Schema.String),
  checksSummary: optional(ChecksSummary),
  unavailable: optional(Schema.Boolean),
});
export type SessionPullRequest = typeof SessionPullRequest.Type;
export const SessionPullRequests = Schema.Struct({
  prs: Schema.Array(SessionPullRequest),
  truncated: Schema.Boolean,
});
export type SessionPullRequests = typeof SessionPullRequests.Type;

/** Exact event times, so a reminder's countdown stays current on the device. */
export const CalendarEvent = Schema.Struct({ startsAt: IsoDate, endsAt: optional(IsoDate) });
export type CalendarEvent = typeof CalendarEvent.Type;

/** The prompt that hands a PR's merge conflicts to Codex, and the folder Codex should open. */
export const ConflictFix = Schema.Struct({ prompt: Schema.String, folder: Schema.String });
export type ConflictFix = typeof ConflictFix.Type;

/** GitHub's native stack, ordered from the base upwards. Merge blockers are independent of CI. */
export const PRStack = Schema.Struct({
  number: Count,
  position: Count,
  size: Count,
  base: Schema.String,
  entries: Schema.Array(
    Schema.Struct({
      position: Count,
      number: Count,
      title: Schema.String,
      url: WebUrl,
      status: Schema.Literals([
        "Ready",
        "Conflicts",
        "Approval needed",
        "Changes requested",
        "Draft",
        "Behind base",
        "Blocked",
        "Checks not passed",
        "Checking",
        "Merged",
        "Closed",
      ]),
    }),
  ),
});
export type PRStack = typeof PRStack.Type;

export const Row = Schema.Struct({
  kind: Schema.Literals(["pr", "slack", "notion", "ticket"]),
  title: Schema.String,
  url: WebUrl,
  subtitle: optional(Schema.String),
  status: optional(Schema.String),
  statusType: optional(Schema.String),
  priority: optional(Schema.String),
  priorityValue: optional(Schema.Finite),
  checks: optional(Schema.String),
  prKey: optional(Schema.String),
  prState: optional(PRState),
  checksSummary: optional(ChecksSummary),
  stack: optional(PRStack),
  aiCheckFailures: optional(Schema.Array(Schema.String)),
  changes: optional(PRChanges),
  draft: optional(Schema.Boolean),
  merged: optional(Schema.Boolean),
  badges: optional(Schema.Array(Badge)),
  updatedAt: optional(IsoDate),
  linkTicketId: optional(Schema.String),
  reference: optional(Schema.String),
  owner: optional(Person),
  assignees: optional(Schema.Array(Person)),
  reviewers: optional(Schema.Array(Person)),
  effort: optional(Schema.String),
  createdAt: optional(IsoDate),
  /** Jev's chance a ticket named in a Scoping doc is that card's own work. */
  jev: optional(Chance),
  conflictFix: optional(ConflictFix),
});
export type Row = typeof Row.Type;

export const Card = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  subtitle: Schema.String,
  status: Schema.String,
  priority: optional(Schema.String),
  url: optional(WebUrl),
  updatedAt: optional(IsoDate),
  attention: Schema.Array(Schema.String),
  labels: Schema.Array(Schema.String),
  links: Schema.Array(Link),
  sessions: Schema.Array(Session),
  related: Schema.Array(Schema.Struct({ title: Schema.String, detail: Schema.String, url: WebUrl })),
  linkTicketId: optional(Schema.String),
  kind: Schema.Literals(["issue", "scoping", "pr", "review", "session", "notification"]),
  feedSource: optionalDisplay(["github", "linear", "slack", "notion"]),
  calendarEvent: optional(CalendarEvent),
  feedTab: optional(Schema.Literals(["direct", "threads", "asks", "saved"])),
  unread: optional(Schema.Boolean),
  /** A saved Slack item Jev judged done: it sits in Saved's folded Done group. */
  done: optional(Schema.Boolean),
  /** Saved items: Jev's chance it still needs you. */
  jev: optional(Chance),
  statusType: optional(Schema.String),
  priorityValue: optional(Schema.Finite),
  labelColors: optional(Schema.Record(Schema.String, Schema.String)),
  assigned: optional(Schema.Struct({ at: IsoDate, people: Schema.Array(Person) })),
  badges: optional(Schema.Array(Badge)),
  rows: optional(Schema.Array(Row)),
  /** Original review-action group, retained when native stacks share a presentation container. */
  reviewGroupId: optional(Schema.String),
  /** Explicit PR links distinguish companions when a shared ticket joins several stack layers. */
  reviewCompanions: optional(Schema.Array(WebUrl)),
  reviewStackLayer: optional(WebUrl),
  prKey: optional(Schema.String),
  prState: optional(PRState),
  checks: optional(Schema.String),
  checksSummary: optional(ChecksSummary),
  stack: optional(PRStack),
  aiCheckFailures: optional(Schema.Array(Schema.String)),
  changes: optional(PRChanges),
  reviewDecision: optional(Schema.String),
  author: optional(Person),
  people: optional(Schema.Array(Person)),
  conflictFix: optional(ConflictFix),
});
export type Card = typeof Card.Type;

export const Group = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  collapsed: Schema.Boolean,
  cards: Schema.Array(Card),
  presentation: optionalDisplay(["section", "review-group", "review-stack"]),
  /** Stack context survives filters that hide the native PR but retain its cross-repository companion. */
  reviewStacks: optional(Schema.Array(Schema.Struct({ url: WebUrl, stack: PRStack }))),
});
export type Group = typeof Group.Type;

export const SectionResponse = Schema.Struct({
  version: Schema.Literal(1),
  section: SectionName,
  generatedAt: IsoDate,
  updatedAt: Schema.NullOr(IsoDate),
  stale: Schema.Boolean,
  groups: Schema.Array(Group),
  coverage: optional(Schema.Array(Coverage)),
  threadsState: optional(Schema.Literals(["loading", "ready", "error"])),
});
export type SectionResponse = typeof SectionResponse.Type;

export const Connection = Schema.Struct({
  name: Schema.String,
  state: display(["connected", "error", "not-connected", "unknown"], "unknown"),
  checkedAt: Schema.NullOr(Schema.String),
  lastSyncedAt: optional(Schema.NullOr(IsoDate)),
  /** Latest acceptable refresh time, based on the provider’s own schedule; null means incomplete data. */
  refreshDueAt: optional(Schema.NullOr(IsoDate)),
  message: optional(Schema.String),
});
export type Connection = typeof Connection.Type;

export const HealthResponse = Schema.Struct({
  version: Schema.Literal(1),
  name: Schema.Literal("Mondash"),
  at: IsoDate,
  connections: Schema.Array(Connection),
});
export type HealthResponse = typeof HealthResponse.Type;

export const ActivitySource = Schema.Literals(["linear", "github", "slack", "notion", "claude", "codex"]);
export type ActivitySource = typeof ActivitySource.Type;
export const ActivityEntity = Schema.Struct({
  id: Schema.String,
  source: ActivitySource,
  card: Card,
  workIds: Schema.Array(Schema.String),
  inCurrentWork: Schema.Boolean,
});
export type ActivityEntity = typeof ActivityEntity.Type;
export const ActivityEvent = Schema.Struct({
  id: Schema.String,
  entityId: Schema.String,
  action: Schema.String,
  occurredAt: Schema.NullOr(IsoDate),
  observedAt: IsoDate,
  timeBasis: Schema.Literals(["source", "observed", "unknown"]),
  /** State at this moment; current state always comes from the entity. */
  detail: optional(Schema.String),
});
export type ActivityEvent = typeof ActivityEvent.Type;
export const ActivityResponse = Schema.Struct({
  version: Schema.Literal(1),
  generatedAt: IsoDate,
  recordingSince: IsoDate,
  entities: Schema.Array(ActivityEntity),
  events: Schema.Array(ActivityEvent),
  sections: Schema.Array(
    Schema.Struct({ section: SectionName, updatedAt: Schema.NullOr(IsoDate), stale: Schema.Boolean }),
  ),
  unavailable: Schema.Array(SectionName),
});
export type ActivityResponse = typeof ActivityResponse.Type;
export const ActivityPreferences = Schema.Struct({
  view: Schema.Literals(["stream", "trails", "lanes", "attention"]),
  query: Schema.String,
  days: Schema.Literals([1, 3, 7, 30, 90]),
  sources: Schema.Array(ActivitySource),
  needs: Schema.Boolean,
  work: Schema.String,
  selected: Schema.NullOr(Schema.String),
  handled: Schema.Record(Schema.String, Schema.String),
  hidden: Schema.optional(Schema.Array(Schema.Literals(["snippets", "links", "history"]))),
});
export type ActivityPreferences = typeof ActivityPreferences.Type;

export const ClaudeSignIn = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  state: Schema.Literals(["waiting", "verifying", "connected", "error", "expired"]),
  url: Schema.optional(Schema.String),
  expiresAt: IsoDate,
  message: Schema.optional(Schema.String),
});
export type ClaudeSignIn = typeof ClaudeSignIn.Type;

const SlackMessageUrl = Schema.String.check(
  Schema.isPattern(/^https:\/\/[a-z0-9-]+\.slack\.com\/archives\/\w+\/p\d{16}(\?[^#\s]*)?$/, {
    message: "Use a Slack message HTTPS link",
  }),
);
export const LinkInput = Schema.Struct({
  ticketId: Schema.String.check(Schema.isPattern(/^[A-Z]+-\d+$/)),
  url: SlackMessageUrl,
  force: Schema.Boolean.pipe(Schema.optionalKey, Schema.withDecodingDefaultKey(Effect.succeed(false))),
});
export type LinkInput = typeof LinkInput.Type;

export const LinkResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("linked") }),
  Schema.Struct({ status: Schema.Literal("confirm"), score: Schema.Finite }),
]);
export type LinkResult = typeof LinkResult.Type;

export { DebriefRange, DebriefItem, DebriefReport, DebriefState, DebriefHistoryEntry } from "./debrief";
