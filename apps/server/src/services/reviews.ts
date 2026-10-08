import { Context, Effect, Layer } from "effect";
import type { ClaudeReview, ClaudeReviewPreview } from "@/lib/claude-review";
import { resolveReviewScope } from "@/lib/review-scope-github";
import { Claude } from "./claude";
import { type ActionFailure, toActionFailure } from "./errors";
import type { Gh } from "./gh";
import type { Linear } from "./linear";
import type { Store } from "./store";

/** Read-only Claude PR risk reviews of a PR and its related PRs. */
export class Reviews extends Context.Service<
  Reviews,
  {
    /** `prompt` replaces the usual first message of a new review; a reopened review is sent none. */
    start(url: string, startNew?: boolean, prompt?: string): Effect.Effect<ClaudeReview, ActionFailure>;
    /** What `start` would do with the same PR: the PRs it would cover, and the prompt it would send. */
    preview(url: string, startNew?: boolean): Effect.Effect<ClaudeReviewPreview, ActionFailure>;
  }
>()("mondash/server/Reviews") {
  static readonly layer = Layer.effect(
    Reviews,
    Effect.gen(function* () {
      const claude = yield* Claude;
      const context = yield* Effect.context<Gh | Linear | Store>();
      return Reviews.of({
        start: (url, startNew = false, prompt) =>
          resolveReviewScope(url).pipe(
            Effect.provideContext(context),
            Effect.flatMap((scope) => claude.startReview(scope, startNew, prompt)),
            Effect.mapError(
              toActionFailure("startReview", "Could not gather the related pull requests. Try again shortly."),
            ),
            Effect.withSpan("Reviews.start", { attributes: { url, edited: prompt !== undefined } }),
          ),
        preview: (url, startNew = false) =>
          resolveReviewScope(url).pipe(
            Effect.provideContext(context),
            Effect.flatMap((scope) => claude.previewReview(scope, startNew)),
            Effect.mapError(
              toActionFailure("previewReview", "Could not gather the related pull requests. Try again shortly."),
            ),
            Effect.withSpan("Reviews.preview", { attributes: { url } }),
          ),
      });
    }),
  );
}
