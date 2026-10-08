import { Context, Effect, Layer } from "effect";
import type { OpenedSession } from "@mondash/shared/api";
import type {
  SessionAttachment,
  SessionConversation,
  SessionFiles,
  SessionPullRequests,
} from "@mondash/shared/contract";
import type { SessionSearchInput, SessionSearchResult } from "@mondash/shared/session-search";
import { rankSessions } from "@/lib/session-search";
import { ServerConfig } from "@/config";
import { kickoff, type Kickoff } from "@/lib/claude-remote";
import { codexHost } from "@/lib/codex-remote-host";
import { openClaudeSession } from "@/lib/dashboard-actions";
import { claudeMacHost } from "@/lib/claude-mac";
import { archiveCodexSession } from "@/lib/codex-archive";
import { ActionError } from "@/lib/action-error";
import {
  getLocalFiles,
  getLocalAttachment,
  getLocalConversation,
  getLocalSession,
  getSessionWithContinuations,
  rebuildRecentSessions,
} from "@/lib/sessions";
import { Claude } from "./claude";
import { ActionFailure, toActionFailure } from "./errors";
import { Store } from "./store";
import { Gh } from "./gh";
import { pullRequestsForSession } from "@/lib/session-prs";
import { readCodexThreads } from "@/lib/codex-threads";
import { homedir } from "node:os";
import { join } from "node:path";
import { RECENT_KEY } from "@/lib/sessions";

/** Claude Code and Codex sessions on the Mac: open them on the phone, or in the Mac's terminal. */
export class Sessions extends Context.Service<
  Sessions,
  {
    archive(
      tool: "claude" | "codex",
      sessionId: string,
      archived: boolean,
    ): Effect.Effect<{ archived: boolean }, ActionFailure>;
    search(input: SessionSearchInput): Effect.Effect<SessionSearchResult, ActionFailure>;
    open(tool: "claude" | "codex", sessionId: string): Effect.Effect<typeof OpenedSession.Type, ActionFailure>;
    openOnMac(sessionId: string, target: "terminal" | "claude-desktop"): Effect.Effect<void, ActionFailure>;
    openInTerminal(sessionId: string): Effect.Effect<void, ActionFailure>;
    /** A new, empty Claude session on the Mac in auto mode, opened on the phone. */
    startNew(tool: "claude"): Effect.Effect<typeof OpenedSession.Type, ActionFailure>;
    /**
     * A Claude session that reads a ticket and plans the change (or what its PRs leave), or reads a PR with no known
     * ticket and works out what is left, opened on the phone. `prompt` replaces its usual first message.
     */
    startKickoff(request: Kickoff, prompt?: string): Effect.Effect<typeof OpenedSession.Type, ActionFailure>;
    /** The first message `startKickoff` sends when it is given no `prompt`. */
    kickoffPrompt(request: Kickoff): Effect.Effect<string>;
    /** The recent conversation of a session on the Mac, read from its transcript. */
    attachment(
      tool: "claude" | "codex",
      sessionId: string,
      attachmentId: string,
    ): Effect.Effect<SessionAttachment, ActionFailure>;
    files(tool: "claude" | "codex", sessionId: string): Effect.Effect<SessionFiles, ActionFailure>;
    conversation(tool: "claude" | "codex", sessionId: string): Effect.Effect<SessionConversation, ActionFailure>;
    pullRequests(tool: "claude" | "codex", sessionId: string): Effect.Effect<SessionPullRequests, ActionFailure>;
  }
>()("mondash/server/Sessions") {
  static readonly layer = Layer.effect(
    Sessions,
    Effect.gen(function* () {
      const claude = yield* Claude;
      const config = yield* ServerConfig;
      const store = yield* Store;
      const gh = yield* Gh;
      const openOnMac = claudeMacHost(config.claudeBin, config.terminalApp);
      const context = yield* Effect.context<ServerConfig | Store>();
      // The Codex handoff takes Promise callbacks: its session lookup runs with this layer's services and the
      // current span, and stops when the call is interrupted.
      const openCodex = (sessionId: string) =>
        Effect.gen(function* () {
          const run = Effect.runPromiseWith(Context.merge(context, yield* Effect.context<never>()));
          return yield* Effect.tryPromise((signal) =>
            codexHost((id) => run(getLocalSession(id), { signal }))(sessionId),
          );
        });
      return Sessions.of({
        archive: (tool, sessionId, archived) =>
          Effect.gen(function* () {
            if (tool !== "codex")
              return yield* Effect.fail(
                new ActionError(
                  "Claude Desktop has no external archive command. Archive this session in Claude on your Mac; Mondash reads its native state.",
                ),
              );
            yield* Effect.tryPromise((signal) => archiveCodexSession(sessionId, archived, signal));
            const record = (yield* readCodexThreads(join(homedir(), ".codex", "state_5.sqlite"))).find(
              (thread) => thread.id === sessionId,
            );
            if (!record || (record.archived !== 0) !== archived)
              return yield* Effect.fail(
                new ActionError("Codex has not confirmed the native archive state. Refresh and try again."),
              );
            yield* (yield* Store).forget(RECENT_KEY.name);
            yield* rebuildRecentSessions();
            return { archived };
          }).pipe(
            Effect.provideContext(context),
            Effect.mapError(
              toActionFailure("archiveSession", "Could not refresh the native archive state. Try again."),
            ),
          ),
        search: (input) =>
          rankSessions(input).pipe(
            Effect.provideContext(context),
            Effect.mapError(
              toActionFailure(
                "sessionSearch",
                "Jev could not rank these sessions. Try again; text matches are still available.",
              ),
            ),
          ),
        open: (tool, sessionId) =>
          (tool === "codex"
            ? openCodex(sessionId).pipe(
                Effect.map((opened): typeof OpenedSession.Type => ({ url: opened.url, handoff: opened.handoff })),
                Effect.mapError(
                  toActionFailure(
                    "openCodexSession",
                    "Could not check Codex on your Mac. Open the ChatGPT desktop app and try again.",
                  ),
                ),
              )
            : claude.openSession(sessionId).pipe(
                Effect.map((url): typeof OpenedSession.Type => ({ url, handoff: "session" })),
                Effect.mapError(
                  toActionFailure(
                    "openClaudeSession",
                    "Could not check Claude on your Mac. Check Claude Code is running correctly, then retry.",
                  ),
                ),
              )
          ).pipe(Effect.withSpan("Sessions.open", { attributes: { tool, sessionId } })),
        startNew: (tool) =>
          claude.newSession.pipe(
            Effect.map((url): typeof OpenedSession.Type => ({ url, handoff: "session" })),
            Effect.mapError(
              toActionFailure(
                "newSession",
                "Could not start a Claude session on your Mac. Check that Claude Code is signed in.",
              ),
            ),
            Effect.withSpan("Sessions.startNew", { attributes: { tool } }),
          ),
        startKickoff: (request, prompt) => {
          const { name, prompt: usual } = kickoff(request);
          return claude.startSession(name, prompt ?? usual).pipe(
            Effect.map((opened): typeof OpenedSession.Type => ({ url: opened, handoff: "session" })),
            Effect.mapError(
              toActionFailure(
                request.kind === "ticket" ? "ticketSession" : "prSession",
                "Could not start a Claude session on your Mac. Check that Claude Code is signed in.",
              ),
            ),
            Effect.withSpan("Sessions.startKickoff", {
              attributes: { ...request, edited: prompt !== undefined },
            }),
          );
        },
        kickoffPrompt: (request) => Effect.sync(() => kickoff(request).prompt),
        attachment: (tool, sessionId, attachmentId) =>
          getLocalAttachment(tool, sessionId, attachmentId).pipe(
            Effect.mapError(
              toActionFailure(
                "sessionAttachment",
                "This attachment is unavailable on your Mac, or is larger than the 8 MB preview limit.",
              ),
            ),
            Effect.flatMap((found) =>
              found
                ? Effect.succeed(found)
                : Effect.fail(
                    new ActionFailure({
                      action: "sessionAttachment",
                      message: "This attachment is no longer available in this session.",
                      cause: new Error("Attachment not found"),
                    }),
                  ),
            ),
          ),
        files: (tool, sessionId) =>
          getLocalFiles(tool, sessionId).pipe(
            Effect.mapError(toActionFailure("sessionFiles", "Could not read the project files. Try again.")),
            Effect.flatMap((found) =>
              found
                ? Effect.succeed(found)
                : Effect.fail(
                    new ActionFailure({
                      action: "sessionFiles",
                      message: "This project is unavailable on your Mac.",
                      cause: new Error("No session"),
                    }),
                  ),
            ),
          ),
        pullRequests: (tool, sessionId) =>
          getLocalConversation(tool, sessionId).pipe(
            Effect.flatMap((found) =>
              Effect.gen(function* () {
                if (!found) return yield* Effect.fail(new ActionError("Session not found"));
                return yield* pullRequestsForSession(yield* getSessionWithContinuations(found.session));
              }),
            ),
            Effect.provideService(Store, store),
            Effect.provideService(Gh, gh),
            Effect.mapError(
              toActionFailure("sessionPullRequests", "Could not load this session's pull requests. Try again."),
            ),
          ),
        conversation: (tool, sessionId) =>
          getLocalConversation(tool, sessionId).pipe(
            Effect.mapError(
              toActionFailure("sessionConversation", "Could not read this session on your Mac. Try again."),
            ),
            Effect.flatMap((found) =>
              found
                ? Effect.succeed({
                    tool,
                    id: sessionId,
                    title: found.session.title,
                    turns: found.turns,
                    truncated: found.truncated,
                    ...(found.running === undefined ? {} : { running: found.running }),
                  })
                : Effect.fail(
                    new ActionFailure({
                      action: "sessionConversation",
                      message: "This session is not on your Mac, or had no messages in the last 90 days.",
                      cause: new Error(`No ${tool} session ${sessionId}`),
                    }),
                  ),
            ),
            Effect.withSpan("Sessions.conversation", { attributes: { tool, sessionId } }),
          ),
        openOnMac: (sessionId, target) =>
          claude.reviewLaunches.pipe(
            Effect.flatMap((launches) => openClaudeSession(sessionId, target, openOnMac, launches)),
            Effect.provideContext(context),
            Effect.mapError(toActionFailure("openOnMac", "Could not open the session on your Mac. Try again.")),
          ),
        openInTerminal: (sessionId) =>
          claude.reviewLaunches.pipe(
            Effect.flatMap((launches) => openClaudeSession(sessionId, undefined, openOnMac, launches)),
            Effect.provideContext(context),
            Effect.mapError(toActionFailure("openInTerminal", "Could not open the terminal on your Mac. Try again.")),
            Effect.withSpan("Sessions.openInTerminal", { attributes: { sessionId } }),
          ),
      });
    }),
  );
}
