import { enabled } from "../profile";
import { join } from "node:path";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { ServerConfig } from "@/config";
import { claudeHost } from "@/lib/claude-remote";
import {
  claudeReviewLauncher,
  createClaudeReviewRegistry,
  previewClaudeReview,
  type ClaudeReview,
  type ClaudeReviewLaunch,
  type ClaudeReviewPreview,
  type ClaudeReviewScope,
} from "@/lib/claude-review";
import { causeText } from "./errors";

/** The Claude Code CLI failed or refused; an ActionError cause carries words for the person. */
export class ClaudeFailure extends Schema.TaggedError<ClaudeFailure>()("ClaudeFailure", {
  cause: Schema.Defect(),
}) {
  override get message() {
    return `Claude Code: ${causeText(this.cause)}`;
  }
}

/** Claude Code on the Mac: hand a session to the phone over Remote Control, and start read-only PR reviews. */
export class Claude extends Context.Service<
  Claude,
  {
    /** The claude.ai URL of the session, once Remote Control has it. */
    openSession(sessionId: string): Effect.Effect<string, ClaudeFailure>;
    /**
     * A PR risk review; the one already covering these PRs is reopened unless `startNew`. `prompt` replaces the usual
     * first message of a new review.
     */
    startReview(
      scope: ClaudeReviewScope,
      startNew?: boolean,
      prompt?: string,
    ): Effect.Effect<ClaudeReview, ClaudeFailure>;
    /** What `startReview` would do with the same arguments, without doing it. */
    previewReview(scope: ClaudeReviewScope, startNew?: boolean): Effect.Effect<ClaudeReviewPreview, ClaudeFailure>;
    /** An empty session in auto mode, for the Sessions tab's "New Claude session"; the claude.ai URL once connected. */
    readonly newSession: Effect.Effect<string, ClaudeFailure>;
    /** A session in auto mode with `prompt` as its first message; a running session named `name` is reused. */
    startSession(name: string, prompt: string): Effect.Effect<string, ClaudeFailure>;
    readonly reviewLaunches: Effect.Effect<ReadonlyArray<ClaudeReviewLaunch>, ClaudeFailure>;
  }
>()("mondash/server/Claude") {
  static readonly layer = Layer.effect(
    Claude,
    Effect.gen(function* () {
      if (!enabled("sessions")) {
        const disabled = Effect.fail(
          new ClaudeFailure({ cause: new Error("Local sessions are disabled in Settings") }),
        );
        return Claude.of({
          openSession: () => disabled,
          startReview: () => disabled,
          previewReview: () => disabled,
          newSession: disabled,
          startSession: () => disabled,
          reviewLaunches: Effect.succeed([]),
        });
      }
      const { claudeBin, newSessionDir } = yield* ServerConfig;
      const host = claudeHost(claudeBin);
      const registry = yield* Effect.acquireRelease(
        Effect.sync(() => createClaudeReviewRegistry(join(process.cwd(), ".cache", "claude-reviews.db"))),
        (opened) => Effect.sync(() => opened.close()),
      );
      const launch = claudeReviewLauncher(host, registry);
      const attempt = <A>(run: () => Promise<A>) =>
        Effect.tryPromise({ try: run, catch: (cause) => new ClaudeFailure({ cause }) });
      return Claude.of({
        openSession: (sessionId) =>
          attempt(() => host.open(sessionId)).pipe(
            Effect.withSpan("Claude.openSession", { attributes: { sessionId } }),
          ),
        startReview: (scope, startNew = false, prompt) =>
          attempt(() => launch(scope, startNew, prompt)).pipe(
            Effect.withSpan("Claude.startReview", { attributes: { urls: scope.urls, edited: prompt !== undefined } }),
          ),
        previewReview: (scope, startNew = false) =>
          attempt(async () => previewClaudeReview(registry.list(), scope, startNew)).pipe(
            Effect.withSpan("Claude.previewReview", { attributes: { urls: scope.urls } }),
          ),
        reviewLaunches: attempt(async () => registry.list()),
        newSession: Effect.gen(function* () {
          const now = yield* DateTime.now;
          const name = `Mondash ${DateTime.format(now, { locale: "en-GB", dateStyle: "medium", timeStyle: "short" })}`;
          return yield* attempt(() => host.startNew(newSessionDir, name));
        }).pipe(Effect.withSpan("Claude.newSession")),
        startSession: (name, prompt) =>
          attempt(() => host.startNew(newSessionDir, name, prompt)).pipe(
            Effect.withSpan("Claude.startSession", { attributes: { name } }),
          ),
      });
    }),
  );
}
