import { Profile, SetupResponse, NotionSetupCheck } from "./setup";
import {
  SettingsResponse,
  Account,
  WorkSource,
  SettingsCommand,
  AppliedSettings,
  NotionCandidates,
  NotionInspection,
} from "./settings";
import { DebriefRange, DebriefState, DebriefReport, DebriefHistoryEntry } from "./debrief";
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import {
  ClaudeSignIn,
  HealthResponse,
  LinkInput,
  LinkResult,
  SectionName,
  SectionResponse,
  SessionConversation,
  SessionAttachment,
  SessionFiles,
  SessionPullRequests,
  ActivityResponse,
} from "./contract";
import { desktopLinkProvider } from "./desktop-link";
import { SessionSearchInput, SessionSearchResult } from "./session-search";

/** A source (Linear, Slack, Notion, GitHub) could not answer, and nothing was cached to fall back on. */
export class SourceUnavailable extends Schema.TaggedError<SourceUnavailable>()(
  "SourceUnavailable",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

/** The Mac tried the action and it did not work; the message says why, in words for the person. */
export class ActionFailed extends Schema.TaggedError<ActionFailed>()(
  "ActionFailed",
  { message: Schema.String },
  { httpApiStatus: 422 },
) {}

const ClaudeSessionUrl = Schema.String.check(Schema.isPattern(/^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]+$/));
const Uuid = Schema.String.check(Schema.isUUID());
const LinearIssueUrl = Schema.String.check(
  Schema.isPattern(/^https:\/\/linear\.app\/[\w-]+\/issue\/[A-Z]+-\d+(\/[\w-]*)?$/),
);
export const PullRequestUrl = Schema.String.check(
  Schema.isPattern(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/),
);

/**
 * A first message for Claude that replaces the one the Mac builds. It reaches the CLI as one argument, so it cannot
 * hold a NUL character.
 */
const Prompt = Schema.String.check(
  Schema.isMaxLength(20_000),
  Schema.isPattern(/\S/),
  Schema.makeFilter((value: string) => !value.includes("\0")),
);
const TicketId = Schema.String.check(Schema.isPattern(/^[A-Z]+-\d+$/));

export const DesktopLinkUrl = Schema.String.check(
  Schema.isMaxLength(8_000),
  Schema.makeFilter((value) => desktopLinkProvider(value) !== undefined),
);

/** A start that sends Claude a prompt: the prompt sheet asks the Mac for it first, so the person can read and edit it. */
export const PromptRequest = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("ticket"),
    ticketId: TicketId,
    url: LinearIssueUrl,
    prs: Schema.optional(Schema.Array(PullRequestUrl)),
  }),
  Schema.Struct({ kind: Schema.Literal("pr"), url: PullRequestUrl }),
  Schema.Struct({ kind: Schema.Literal("review"), url: PullRequestUrl, startNew: Schema.optional(Schema.Boolean) }),
]);

export const PromptPreview = Schema.Struct({
  /** Exactly what the start sends when it is given no prompt. */
  prompt: Schema.String,
  /** A review's PRs, and the related ones it leaves alone because they are not ready. */
  review: Schema.optional(
    Schema.Struct({
      prs: Schema.Array(PullRequestUrl),
      notReady: Schema.Array(PullRequestUrl),
      /** A review of these PRs exists, so a start reopens it and sends no prompt. */
      reopens: Schema.Boolean,
    }),
  ),
});

export const OpenedSession = Schema.Struct({
  url: Schema.Union([ClaudeSessionUrl, Schema.Literal("https://chatgpt.com/open-app")]),
  handoff: Schema.optional(Schema.Literals(["session", "app"])),
});

export const StartedReview = Schema.Struct({
  url: ClaudeSessionUrl,
  sessionId: Schema.String,
  reused: Schema.Boolean,
});

/** Everything the app reads from, and asks of, the Mac. The server implements it; the app derives its client from it. */
export class MondashApi extends HttpApi.make("mondash")
  .add(
    HttpApiGroup.make("activity").add(
      HttpApiEndpoint.get("read", "/api/activity", {
        success: ActivityResponse,
        error: SourceUnavailable,
      }),
    ),
  )
  .add(
    HttpApiGroup.make("agentAuth")
      .add(
        HttpApiEndpoint.post("startClaude", "/api/agent-auth/claude/start", {
          payload: Schema.Struct({}),
          success: ClaudeSignIn,
          error: ActionFailed,
        }),
      )
      .add(
        HttpApiEndpoint.get("claudeStatus", "/api/agent-auth/claude/:id", {
          params: Schema.Struct({ id: Uuid }),
          success: ClaudeSignIn,
          error: ActionFailed,
        }),
      )
      .add(
        HttpApiEndpoint.post("callbackClaude", "/api/agent-auth/claude/:id/callback", {
          params: Schema.Struct({ id: Uuid }),
          payload: Schema.Struct({
            code: Schema.String.check(Schema.isMaxLength(4096), Schema.isPattern(/^\S+$/)),
            state: Schema.String.check(Schema.isMaxLength(512), Schema.isPattern(/^\S+$/)),
          }),
          success: ClaudeSignIn,
          error: ActionFailed,
        }),
      ),
  )
  .add(
    HttpApiGroup.make("debrief")
      .add(HttpApiEndpoint.get("read", "/api/inbox/debrief", { success: DebriefState, error: ActionFailed }))
      .add(
        HttpApiEndpoint.get("history", "/api/inbox/debrief/history", {
          success: Schema.Array(DebriefHistoryEntry),
          error: ActionFailed,
        }),
      )
      .add(
        HttpApiEndpoint.get("report", "/api/inbox/debrief/reports/:id", {
          params: { id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)) },
          success: Schema.NullOr(DebriefReport),
          error: ActionFailed,
        }),
      )
      .add(
        HttpApiEndpoint.post("generate", "/api/inbox/debrief", {
          payload: DebriefRange,
          success: DebriefState,
          error: ActionFailed,
        }),
      ),
  )
  .add(
    HttpApiGroup.make("settings")
      .add(HttpApiEndpoint.get("read", "/api/settings", { success: SettingsResponse, error: ActionFailed }))
      .add(
        HttpApiEndpoint.post("discover", "/api/settings/discover", {
          payload: Schema.Struct({ source: WorkSource }),
          success: Account,
          error: ActionFailed,
        }),
      )
      .add(
        HttpApiEndpoint.post("apply", "/api/settings/apply", {
          payload: SettingsCommand,
          success: AppliedSettings,
          error: ActionFailed,
        }),
      )
      .add(
        HttpApiEndpoint.post("notionSearch", "/api/settings/notion/search", {
          payload: Schema.Struct({ query: Schema.String }),
          success: NotionCandidates,
          error: ActionFailed,
        }),
      )
      .add(
        HttpApiEndpoint.post("notionInspect", "/api/settings/notion/inspect", {
          payload: Schema.Struct({ id: Schema.NonEmptyString }),
          success: NotionInspection,
          error: ActionFailed,
        }),
      ),
  )
  .add(
    HttpApiGroup.make("setup")
      .add(HttpApiEndpoint.get("notion", "/api/setup/notion", { success: NotionSetupCheck, error: ActionFailed }))
      .add(HttpApiEndpoint.get("read", "/api/setup", { success: SetupResponse, error: ActionFailed }))
      .add(
        HttpApiEndpoint.put("save", "/api/setup", { payload: Profile, success: SetupResponse, error: ActionFailed }),
      ),
  )
  .add(
    HttpApiGroup.make("dashboard")
      .add(HttpApiEndpoint.get("health", "/api/health", { success: HealthResponse, error: SourceUnavailable }))
      .add(
        HttpApiEndpoint.get("section", "/api/sections/:section", {
          params: { section: SectionName },
          success: SectionResponse,
          error: SourceUnavailable,
        }),
      ),
  )
  .add(
    HttpApiGroup.make("sessions")
      .add(
        HttpApiEndpoint.get("files", "/api/sessions/:tool/:id/files", {
          params: { tool: Schema.Literals(["claude", "codex"]), id: Uuid },
          success: SessionFiles,
          error: ActionFailed,
        }),
      )
      .add(
        HttpApiEndpoint.post("archive", "/api/sessions/archive", {
          payload: Schema.Struct({
            tool: Schema.Literals(["claude", "codex"]),
            sessionId: Uuid,
            archived: Schema.Boolean,
          }),
          success: Schema.Struct({ archived: Schema.Boolean }),
          error: ActionFailed,
        }),
      )
      .add(
        // Read from the transcript on the Mac, found by the session's id: the phone never names a file.
        HttpApiEndpoint.get("conversation", "/api/sessions/:tool/:id/messages", {
          params: { tool: Schema.Literals(["claude", "codex"]), id: Uuid },
          success: SessionConversation,
          error: ActionFailed,
        }),
      )
      .add(
        HttpApiEndpoint.get("pullRequests", "/api/sessions/:tool/:id/pull-requests", {
          params: { tool: Schema.Literals(["claude", "codex"]), id: Uuid },
          success: SessionPullRequests,
          error: ActionFailed,
        }),
      )
      .add(
        HttpApiEndpoint.get("attachment", "/api/sessions/:tool/:id/attachments/:attachmentId", {
          params: {
            tool: Schema.Literals(["claude", "codex"]),
            id: Uuid,
            attachmentId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
          },
          success: SessionAttachment,
          error: ActionFailed,
        }),
      )
      .add(
        HttpApiEndpoint.post("search", "/api/sessions/search", {
          payload: SessionSearchInput,
          success: SessionSearchResult,
          error: ActionFailed,
        }),
      ),
  )
  .add(
    HttpApiGroup.make("actions")
      .add(
        HttpApiEndpoint.post("openDesktopLink", "/api/links/open-desktop", {
          payload: Schema.Struct({ url: DesktopLinkUrl }),
          success: Schema.Struct({ opened: Schema.Boolean }),
        }),
      )
      .add(
        HttpApiEndpoint.post("markRead", "/api/inbox/read", {
          payload: Schema.Struct({
            id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
            read: Schema.Boolean,
          }),
          error: ActionFailed,
        }),
      )
      .add(
        HttpApiEndpoint.post("linkSlackThread", "/api/tickets/link-slack", {
          payload: LinkInput,
          success: LinkResult,
          error: ActionFailed,
        }),
      )
      .add(
        HttpApiEndpoint.post("openSession", "/api/sessions/open", {
          payload: Schema.Struct({ sessionId: Uuid, tool: Schema.Literals(["claude", "codex"]) }),
          success: OpenedSession,
          error: ActionFailed,
        }),
      )
      .add(
        HttpApiEndpoint.post("newSession", "/api/sessions/new", {
          payload: Schema.Struct({ tool: Schema.Literal("claude") }),
          success: OpenedSession,
          error: ActionFailed,
        }),
      )
      .add(
        HttpApiEndpoint.post("ticketSession", "/api/tickets/session", {
          payload: Schema.Struct({
            ticketId: TicketId,
            url: LinearIssueUrl,
            prs: Schema.optional(Schema.Array(PullRequestUrl)),
            prompt: Schema.optional(Prompt),
          }),
          success: OpenedSession,
          error: ActionFailed,
        }),
      )
      .add(
        HttpApiEndpoint.post("prSession", "/api/prs/session", {
          payload: Schema.Struct({ url: PullRequestUrl, prompt: Schema.optional(Prompt) }),
          success: OpenedSession,
          error: ActionFailed,
        }),
      )
      .add(
        HttpApiEndpoint.post("openOnMac", "/api/sessions/open-mac", {
          payload: Schema.Struct({ sessionId: Uuid, target: Schema.Literals(["terminal", "claude-desktop"]) }),
          error: ActionFailed,
        }),
      )
      .add(
        HttpApiEndpoint.post("openInTerminal", "/api/sessions/open-terminal", {
          payload: Schema.Struct({ sessionId: Uuid }),
          error: ActionFailed,
        }),
      )
      .add(
        HttpApiEndpoint.post("startReview", "/api/reviews/start", {
          // startNew: a new review even when one already covers this PR; otherwise that one reopens.
          // prompt: replaces the first message of a new review; a reopened review is sent none.
          payload: Schema.Struct({
            url: PullRequestUrl,
            startNew: Schema.optional(Schema.Boolean),
            prompt: Schema.optional(Prompt),
          }),
          success: StartedReview,
          error: ActionFailed,
        }),
      )
      .add(
        HttpApiEndpoint.post("promptPreview", "/api/sessions/prompt", {
          payload: PromptRequest,
          success: PromptPreview,
          error: ActionFailed,
        }),
      ),
  ) {}
