import { stat } from "node:fs/promises";
import { actionDirectory } from "../profile";
import { Effect, Schema } from "effect";
import { issueById } from "@/lib/linear-api";
import type { Linear } from "@/services/linear";
import { Store } from "@/services/store";
import { FEED_KEY } from "./github-feed.ts";
import { getReviewFeed } from "./github.ts";
import { groupPRs } from "./review-feed.ts";
import {
  createReviewScopeResolver,
  ReviewScopeError,
  parseReviewPRUrl,
  readyForReview,
  reviewTicketIds,
  type ReviewScopePR,
} from "./review-scope.ts";
import { MY_LOGIN } from "./feed.ts";
import { Gh } from "@/services/gh";

// Use the same authenticated GitHub CLI as the existing dashboard integrations; no shell interpolation.
const github = <A>(path: string, schema: Schema.Codec<A, unknown>, paginate = false) =>
  Effect.gen(function* () {
    const gh = yield* Gh;
    return yield* gh.json(["api", path, ...(paginate ? ["--paginate", "--slurp"] : [])], schema, {
      maxBuffer: 16 * 1024 * 1024,
    });
  });
const PR = Schema.Struct({
  html_url: Schema.String,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  state: Schema.Literals(["open", "closed"]),
  merged: Schema.Boolean,
  draft: Schema.Boolean,
  head: Schema.Struct({ ref: Schema.String }),
  requested_reviewers: Schema.Array(Schema.Struct({ login: Schema.String, type: Schema.String })),
  requested_teams: Schema.Array(Schema.Struct({ slug: Schema.String })),
});
const CommentPages = Schema.Array(Schema.Array(Schema.Struct({ body: Schema.NullOr(Schema.String) })));
const ReviewPages = Schema.Array(
  Schema.Array(
    Schema.Struct({
      body: Schema.NullOr(Schema.String),
      state: Schema.String,
      user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
    }),
  ),
);
const SearchPages = Schema.Array(
  Schema.Struct({
    incomplete_results: Schema.Boolean,
    total_count: Schema.Finite,
    items: Schema.Array(
      Schema.Struct({ html_url: Schema.String, title: Schema.String, body: Schema.NullOr(Schema.String) }),
    ),
  }),
);

const cwd = (owner: string, repository?: string) =>
  Effect.gen(function* () {
    const dir = actionDirectory(owner, repository);
    if (!dir)
      return yield* new ReviewScopeError({
        message: "No review workspace is configured on your Mac for this GitHub organization.",
      });
    const unavailable = "The review workspace is unavailable on your Mac.";
    const found = yield* Effect.tryPromise({
      try: () => stat(dir),
      // A missing folder is a known state; any other stat failure keeps its cause for the log.
      catch: (cause) =>
        cause instanceof Error && "code" in cause && cause.code === "ENOENT"
          ? new ReviewScopeError({ message: unavailable })
          : new ReviewScopeError({ message: unavailable, cause }),
    });
    if (!found.isDirectory()) return yield* new ReviewScopeError({ message: unavailable });
    return dir;
  });

const load = (url: string) =>
  Effect.gen(function* () {
    const parsed = parseReviewPRUrl(url);
    if (!parsed) return yield* new ReviewScopeError({ message: "Invalid pull request URL." });
    const repo = `repos/${parsed.owner}/${parsed.repo}`;
    const [pr, discussion, inline, reviews] = yield* Effect.all(
      [
        github(`${repo}/pulls/${parsed.number}`, PR),
        github(`${repo}/issues/${parsed.number}/comments?per_page=100`, CommentPages, true),
        github(`${repo}/pulls/${parsed.number}/comments?per_page=100`, CommentPages, true),
        github(`${repo}/pulls/${parsed.number}/reviews?per_page=100`, ReviewPages, true),
      ],
      { concurrency: "unbounded" },
    );
    return {
      url: pr.html_url,
      title: pr.title,
      body: pr.body === null ? "" : pr.body,
      branch: pr.head.ref,
      state: pr.merged ? "MERGED" : pr.state === "open" ? "OPEN" : "CLOSED",
      comments: [...discussion.flat(), ...inline.flat(), ...reviews.flat()].flatMap((comment) =>
        comment.body ? [comment.body] : [],
      ),
      ready: readyForReview(
        { draft: pr.draft, requestedReviewers: pr.requested_reviewers, requestedTeams: pr.requested_teams },
        reviews.flat().some((review) => review.user?.login === MY_LOGIN && review.state !== "PENDING"),
      ),
    } satisfies ReviewScopePR;
  });

const forTicket = (ticket: string, owner: string) =>
  Effect.gen(function* () {
    const query = encodeURIComponent(`org:${owner} is:pr is:open "${ticket}" in:title,body`);
    const [pages, linear] = yield* Effect.all(
      [
        github(`search/issues?q=${query}&per_page=100`, SearchPages, true),
        // Linear attachments include branches/PRs with no ticket text in the GitHub title or body.
        issueById(ticket).pipe(
          Effect.mapError(
            (cause) =>
              new ReviewScopeError({
                message:
                  "Could not check this ticket’s related pull requests in Linear. Check the Linear connection and try again.",
                cause,
              }),
          ),
        ),
      ],
      { concurrency: "unbounded" },
    );
    if (pages.some((page) => page.incomplete_results || page.total_count > 1000))
      return yield* new ReviewScopeError({
        message: "GitHub could not finish finding related pull requests. Please try again.",
      });
    const urls = pages
      .flatMap((page) => page.items)
      .filter((pr) => reviewTicketIds([pr.title, pr.body].filter(Boolean).join("\n")).includes(ticket))
      .map((pr) => pr.html_url);
    if (linear) {
      urls.push(...linear.attachments.map((attachment) => attachment.url));
    }
    return [...new Set(urls)];
  });

/** The review groups as the Reviews tab has them; GitHub is asked only when nothing is stored. */
const groups = Effect.gen(function* () {
  const stored = yield* (yield* Store).read(FEED_KEY);
  if (stored) return stored.value.groups.map((group) => group.prs);
  const { prs } = yield* getReviewFeed();
  return groupPRs(prs).map((group) => group.prs);
});

export const resolveReviewScope = Effect.fn("review-scope-github.resolveReviewScope")(function* (url: string) {
  const context = yield* Effect.context<Gh | Linear | Store>();
  return yield* Effect.tryPromise({
    try: (signal) => {
      // The resolver takes Promise callbacks, so each one runs its Effect with this call's services, and the
      // signal interrupts it when this call is interrupted.
      const run = <A, E>(effect: Effect.Effect<A, E, Gh | Linear | Store>) =>
        Effect.runPromiseWith(context)(effect, { signal });
      return createReviewScopeResolver({
        groups: () => run(groups),
        cwd: (owner, repository) => run(cwd(owner, repository)),
        load: (prUrl) => run(load(prUrl)),
        forTicket: (ticket, owner) => run(forTicket(ticket, owner)),
      })(url);
    },
    catch: (cause) =>
      cause instanceof ReviewScopeError
        ? cause
        : new ReviewScopeError({
            message:
              "Could not check all related pull requests. Check your Mac’s GitHub and Linear connections, then try again.",
            cause,
          }),
  }).pipe(
    Effect.tapError((error) =>
      error.cause === undefined
        ? Effect.void
        : Effect.logError("Could not resolve the complete review scope", error.cause),
    ),
  );
});
