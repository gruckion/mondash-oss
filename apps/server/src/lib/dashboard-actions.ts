import { Effect, Schema } from "effect";
import { noul } from "@/lib/jev";
import { getLocalSession } from "@/lib/sessions";
import { channelName } from "@/lib/slack-web";
import type { LinkInput, LinkResult } from "@mondash/shared/contract";
import type { claudeMacHost, MacSessionTarget } from "./claude-mac";
import { Mcp, McpFailure } from "@/services/mcp";
import { ForceRefresh, Store } from "@/services/store";
import { attachLink, fetchMine, issueById, MINE_KEY } from "@/lib/linear-api";
import { rebuildResume } from "@/lib/resume";
import { ActionError } from "./action-error";
import type { ClaudeReviewLaunch } from "./claude-review";

// Below this Jev score the button asks you to confirm instead of linking.
const MIN_SCORE = 0.7;

const decodeThread = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ messages: Schema.String })));

/** The reason inside a failure: an MCP failure's own error says what the server answered. */
const reason = (error: unknown): string =>
  error instanceof McpFailure ? reason(error.cause) : error instanceof Error ? error.message : String(error);

/**
 * Links a Slack thread to a Linear ticket, after Jev checks that the thread is about the ticket. Asks to confirm when
 * Jev is not sure; a failure is an ActionError with the reason.
 */
export const linkSlackThread = Effect.fn("dashboard-actions.linkSlackThread")(
  function* ({ ticketId, url, force }: LinkInput) {
    const mcp = yield* Mcp;
    const store = yield* Store;
    const u = yield* Effect.try(() => new URL(url));
    const match = u.pathname.match(/\/archives\/(\w+)\/p(\d{10})(\d{6})/);
    if (!match) return yield* Effect.fail(new ActionError("Not a Slack message link"));
    const [, channelId, seconds, micros] = match;
    // A reply's link carries its thread in ?thread_ts; a parent message's link is the thread itself.
    const threadTs = u.searchParams.get("thread_ts") ?? `${seconds}.${micros}`;

    const [issue, thread, channel] = yield* Effect.all(
      [
        issueById(ticketId).pipe(
          Effect.filterOrFail(
            (found) => found !== undefined,
            () => new ActionError(`Linear has no ticket ${ticketId}`),
          ),
        ),
        mcp.call("slack", "slack_read_thread", { channel_id: channelId, message_ts: threadTs }).pipe(
          Effect.flatMap(decodeThread),
          Effect.map((decoded) => decoded.messages),
        ),
        channelName(channelId),
      ],
      { concurrency: "unbounded" },
    );

    if (!force) {
      const score = yield* noul(
        {
          ticket: { id: ticketId, title: issue.title, description: issue.description },
          slack_thread: thread.slice(0, 6000),
        },
        {
          true: "This Slack thread is where the ticket was reported or discussed, so it belongs on the ticket.",
          false: "The thread only mentions the ticket in passing, or is about something else.",
        },
      );
      if (score < MIN_SCORE) return { status: "confirm", score } satisfies LinkResult;
    }

    const parentBody = thread.split(/^Message TS: [\d.]+$/m)[1];
    const firstLine = parentBody ? parentBody.trim().split("\n")[0] : "";
    const title = `Slack thread${channel ? ` in #${channel}` : ""}: ${firstLine.replace(/<[^>|]+\|([^>]+)>/g, "$1").slice(0, 80)}`;
    yield* attachLink(ticketId, url, title);
    // Rebuilt, not dropped: until the new copies are stored, reads keep showing the old ones.
    yield* store
      .refresh(MINE_KEY, fetchMine, { force: true })
      .pipe(Effect.catch((failure) => Effect.logWarning("Could not refresh your issues after a link", failure)));
    yield* rebuildResume.pipe(
      Effect.provideService(ForceRefresh, true),
      Effect.catchCause((cause) => Effect.logWarning("Could not rebuild Issues after a link", cause)),
      Effect.forkDetach,
    );
    return { status: "linked" } satisfies LinkResult;
  },
  Effect.mapError((error) =>
    error instanceof ActionError
      ? error
      : new ActionError(`Could not link the thread: ${reason(error)}`, { cause: error }),
  ),
);

/**
 * Opens a saved Claude Code session in Desktop or Terminal.app. The legacy terminal action honors TERMINAL_APP.
 * Only the session ID and supported target come from the browser; its folder is resolved on the Mac.
 * A failure is an ActionError that says why.
 */
export const openClaudeSession = Effect.fn("dashboard-actions.openClaudeSession")(function* (
  sessionId: string,
  target: MacSessionTarget,
  open: ReturnType<typeof claudeMacHost>,
  launches: ReadonlyArray<ClaudeReviewLaunch>,
) {
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) return yield* Effect.fail(new ActionError("Invalid session ID"));
  // A managed review is already identified by its launch record, even before its first transcript message.
  const launch = launches.find((record) => record.sessionId === sessionId && record.state !== "failed");
  if (launch) return yield* Effect.tryPromise(() => open(sessionId, launch.cwd, target));
  const session = yield* getLocalSession(sessionId);
  if (session?.tool !== "claude") return yield* Effect.fail(new ActionError("Session not found in the last 90 days"));

  yield* Effect.tryPromise(() => open(sessionId, session.cwd, target));
});
