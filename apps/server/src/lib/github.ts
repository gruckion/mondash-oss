import { enabled } from "../profile";
import { profile, orgScope } from "../profile";
import { Clock, Duration, Effect, Result, Schema } from "effect";
import { CHECK_ROLLUP_FIELDS, ChecksSummary, checkRollupSchema, prChecks } from "./github-checks.ts";
import { DmHint } from "./dm.ts";
import { Reply, toReply } from "./people.ts";
import { AI_REVIEWERS, aiThreads, humanReviewers, reviewFeed, yourReview, type FeedPR } from "./review-feed.ts";
import { Store, storeKey } from "@/services/store";
import { Gh } from "@/services/gh";
import { STACK_FIELDS, stackFields, prStack } from "./github-stack.ts";
import { PRStack, PRChanges } from "@mondash/shared/contract";
import { changeFields, prChanges } from "./github-changes.ts";

// Limit authored work to the configured organization scope; an empty scope includes personal repositories.
const SearchCoverage = { issueCount: Schema.optional(Schema.Finite) };
const recordLimit = (name: string, count: number | undefined, limit: number) =>
  Effect.gen(function* () {
    const store = yield* Store;
    yield* store.write(
      storeKey(`coverage:github-${name}-truncated`, Schema.Boolean),
      count !== undefined && count > limit,
    );
  });

const QUERY = `query MondashMyOpenPRs($after: String) {
  viewer { login }
  mine: search(query: "is:pr is:open author:@me ${orgScope()} sort:updated-desc", type: ISSUE, first: 20, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number title url state isDraft createdAt updatedAt headRefName reviewDecision mergeable additions deletions changedFiles
        ${STACK_FIELDS}
        repository { nameWithOwner }
        commits(last: 1) { nodes { commit { committedDate ${CHECK_ROLLUP_FIELDS} } } }
        reviews(last: 20) { nodes { author { login __typename } state } }
        reviewThreads(last: 50) { nodes { isResolved comments(last: 1) { nodes { ...comment } } } }
        comments(last: 1) { nodes { ...comment } }
      }
    }
  }
}
fragment comment on Comment { author { login __typename } createdAt ... on IssueComment { url } ... on PullRequestReviewComment { url } }`;

const Author = Schema.NullOr(Schema.Struct({ login: Schema.String, __typename: Schema.String }));
const Comment = Schema.Struct({
  // null when the author's account was deleted
  author: Author,
  createdAt: Schema.String,
  url: Schema.String,
});
type Comment = typeof Comment.Type;
type Thread = { readonly isResolved: boolean; readonly comments: { readonly nodes: readonly Comment[] } };
const PRState = Schema.Literals(["OPEN", "MERGED", "CLOSED"]);
const AnyNode = Schema.StructWithRest(Schema.Struct({}), [Schema.Record(Schema.String, Schema.Unknown)]);
const isNumbered = Schema.is(Schema.Struct({ number: Schema.Finite }));

/**
 * The search results that fit the schema. A result with no `number` is not a PR (the fragment selects nothing on other
 * types); a PR that does not fit is logged, so a GitHub shape change does not hide it without a trace.
 */
const decodeNodes = <A>(
  decode: (input: unknown) => Result.Result<A, Schema.SchemaError>,
  nodes: ReadonlyArray<unknown>,
) =>
  Effect.gen(function* () {
    const decoded: A[] = [];
    for (const raw of nodes) {
      const node = decode(raw);
      if (Result.isSuccess(node)) decoded.push(node.success);
      else if (isNumbered(raw))
        yield* Effect.logWarning(
          `GitHub returned PR #${raw.number} in a shape this app does not understand.`,
          node.failure.message,
        );
    }
    return decoded;
  });

const PageInfo = Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) });

const Response = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.Struct({ login: Schema.String }),
    mine: Schema.Struct({
      ...SearchCoverage,
      pageInfo: PageInfo,
      nodes: Schema.Array(
        Schema.Struct({
          ...stackFields,
          number: Schema.Finite,
          ...changeFields,
          title: Schema.String,
          url: Schema.String,
          isDraft: Schema.Boolean,
          state: PRState,
          updatedAt: Schema.String,
          headRefName: Schema.String,
          createdAt: Schema.String,
          reviewDecision: Schema.NullOr(Schema.String),
          reviews: Schema.Struct({
            nodes: Schema.Array(Schema.Struct({ author: Author, state: Schema.String })),
          }),
          mergeable: Schema.Literals(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
          repository: Schema.Struct({ nameWithOwner: Schema.String }),
          commits: Schema.Struct({
            nodes: Schema.Array(
              Schema.Struct({
                commit: Schema.Struct({ committedDate: Schema.String, statusCheckRollup: checkRollupSchema }),
              }),
            ),
          }),
          reviewThreads: Schema.Struct({
            nodes: Schema.Array(
              Schema.Struct({
                isResolved: Schema.Boolean,
                comments: Schema.Struct({ nodes: Schema.Array(Comment) }),
              }),
            ),
          }),
          comments: Schema.Struct({ nodes: Schema.Array(Comment) }),
        }),
      ),
    }),
  }),
});

/** What on a PR waits for you: people's replies, who is waiting in how many threads, and AI review threads. */
export const Attention = Schema.Struct({
  /** The newest comment by another person that you have not answered. */
  reply: Schema.NullOr(Reply),
  waitingBy: Schema.Record(Schema.String, Schema.Finite),
  /** Unresolved threads where an AI reviewer spoke last. Resolving or replying clears them. */
  aiThreads: Schema.NullOr(Schema.Struct({ count: Schema.Finite, url: Schema.String })),
});
export type Attention = typeof Attention.Type;

export const PullRequest = Schema.Struct({
  changes: Schema.optional(PRChanges),
  repo: Schema.String,
  createdAt: Schema.Date,
  /** People (not bots, not you) who reviewed or commented on it: who a DM about this PR would be with. */
  people: Schema.Array(Schema.String),
  /** Who has approved it, by GitHub login. */
  approvedBy: Schema.Array(Schema.String),
  /** A Slack DM that is waiting on you about this PR. Filled in later, in resume.ts. */
  dm: Schema.optional(DmHint),
  number: Schema.Finite,
  title: Schema.String,
  url: Schema.String,
  branch: Schema.String,
  isDraft: Schema.Boolean,
  state: Schema.optional(PRState),
  checksSummary: Schema.optional(ChecksSummary),
  stack: Schema.optional(PRStack),
  aiCheckFailures: Schema.optional(Schema.Array(Schema.String)),
  updatedAt: Schema.Date,
  /** Your last push or comment on it. Other people's reviews move `updatedAt` too, so a reply is read from this. */
  yourLastActivityAt: Schema.optional(Schema.Date),
  review: Schema.NullOr(Schema.String), // APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED
  checks: Schema.NullOr(Schema.String), // SUCCESS, FAILURE, PENDING, ERROR
  /** The branch conflicts with its base. GitHub computes this lazily: UNKNOWN on the first ask, known on a later load. */
  conflicts: Schema.Boolean,
  ...Attention.fields,
});
export type PullRequest = typeof PullRequest.Type;

/**
 * Checks unresolved review threads and the latest PR comment.
 * A thread counts only if someone else wrote its last comment, so replying clears it.
 * Bots are ignored, except the AI reviewers, which are counted separately.
 */
export function attention(threads: readonly Thread[], latestComment: Comment | undefined, me: string): Attention {
  const lastInThreads = threads.filter((t) => !t.isResolved).flatMap((t) => t.comments.nodes.slice(-1));
  const ai = lastInThreads.filter((c) => c.author !== null && AI_REVIEWERS.test(c.author.login));
  const human = [...lastInThreads, ...(latestComment ? [latestComment] : [])].filter(
    (c) => c.author !== null && c.author.__typename === "User" && c.author.login !== me,
  );
  const [firstAi] = ai;
  const waiting = human.flatMap((c) =>
    c.author ? [{ from: c.author.login, at: new Date(c.createdAt), url: c.url }] : [],
  );
  const waitingBy: Record<string, number> = {};
  for (const w of waiting) waitingBy[w.from] = (waitingBy[w.from] ? waitingBy[w.from] : 0) + 1;
  return {
    reply: toReply(waiting),
    waitingBy,
    aiThreads: firstAi ? { count: ai.length, url: firstAi.url } : null,
  };
}

/** When you last touched your own PR: its last commit, or your comment where you spoke last (a PR comment or thread). */
export function yourLastActivity(
  pr: {
    readonly commits: { readonly nodes: readonly { readonly commit: { readonly committedDate: string } }[] };
    readonly reviewThreads: { readonly nodes: readonly Thread[] };
    readonly comments: { readonly nodes: readonly Comment[] };
  },
  me: string,
): Date | undefined {
  const said = [...pr.reviewThreads.nodes.flatMap((t) => t.comments.nodes.slice(-1)), ...pr.comments.nodes.slice(-1)];
  const times = [
    ...pr.commits.nodes.map((c) => c.commit.committedDate),
    ...said.flatMap((c) => (c.author?.login === me ? [c.createdAt] : [])),
  ].map((at) => new Date(at).getTime());
  const latest = Math.max(0, ...times);
  return latest > 0 ? new Date(latest) : undefined;
}

/** The last time your review was asked for, by name or through your team. */
function requestedAt(
  events: (typeof FeedPRNode.Type)["timelineItems"]["nodes"],
  me: string,
  existing: FeedPR | undefined,
): Date | undefined {
  const times = events.flatMap((e) =>
    e.createdAt && e.requestedReviewer && (e.requestedReviewer.login === me || teamMatches(e.requestedReviewer.slug))
      ? [new Date(e.createdAt).getTime()]
      : [],
  );
  const previous = existing?.requestedAt?.getTime();
  const latest = Math.max(0, ...times, previous ? previous : 0);
  return latest > 0 ? new Date(latest) : undefined;
}

/** The team whose review requests are yours too. ponytail: one team; read it from .env if you join another. */
const teamMatches = (slug: string | undefined) => profile.workspace.reviewTeams.some((team) => team.slug === slug);

/** When you last said anything on it: a review, a PR comment, or a comment in a review thread. */
type Said = { readonly author: { readonly login: string } | null; readonly createdAt: string };

function lastWord(
  pr: {
    readonly comments: { readonly nodes: readonly Said[] };
    readonly reviews: {
      readonly nodes: readonly {
        readonly author: { readonly login: string } | null;
        readonly submittedAt: string | null;
      }[];
    };
    readonly reviewThreads: { readonly nodes: readonly { readonly comments: { readonly nodes: readonly Said[] } }[] };
  },
  me: string,
  existing: FeedPR | undefined,
): Date | undefined {
  const times = [
    ...pr.comments.nodes.flatMap((c) => (c.author?.login === me ? [c.createdAt] : [])),
    ...pr.reviews.nodes.flatMap((r) => (r.author?.login === me && r.submittedAt ? [r.submittedAt] : [])),
    ...pr.reviewThreads.nodes.flatMap((t) =>
      t.comments.nodes.flatMap((c) => (c.author?.login === me ? [c.createdAt] : [])),
    ),
  ].map((at) => new Date(at).getTime());
  const previous = existing?.yourLastWordAt?.getTime();
  const latest = Math.max(0, ...times, previous ? previous : 0);
  return latest > 0 ? new Date(latest) : undefined;
}

/** The people who reviewed or commented on a PR: not bots, not you. */
function reviewers(
  pr: {
    readonly reviews: { readonly nodes: readonly { readonly author: typeof Author.Type }[] };
    readonly reviewThreads: { readonly nodes: readonly Thread[] };
  },
  me: string,
): string[] {
  const authors = [
    ...pr.reviews.nodes.map((r) => r.author),
    ...pr.reviewThreads.nodes.flatMap((t) => t.comments.nodes.map((c) => c.author)),
  ];
  return [
    ...new Set(authors.flatMap((a) => (a !== null && a.__typename === "User" && a.login !== me ? [a.login] : []))),
  ];
}

/**
 * Where the PR list lives in the store, so the live checks and the page share one copy.
 * The version is part of the key: bump it when PullRequest gains or loses a field, so old payloads are not read back.
 */
export const PRS_KEY = storeKey("github:my-open-prs:v7", Schema.Array(PullRequest));
// Refreshed when the GitHub probe sees a change (live.ts); this is the backstop.
export const PRS_FRESH = Duration.minutes(10);

/** Recent merged and closed PRs, separate from the older merged-only cache. */
export const OTHER_PRS_KEY = storeKey("github:my-other-prs:v2", Schema.Array(PullRequest));

/** Who has approved: the last state each reviewer left. */
function approvers(reviews: readonly { readonly author: typeof Author.Type; readonly state: string }[]): string[] {
  const last = new Map<string, string>();
  for (const r of reviews) if (r.author) last.set(r.author.login, r.state);
  return [...last].flatMap(([login, state]) => (state === "APPROVED" ? [login] : []));
}

/** "web#1792": how a PR is named in prompts, Jev questions and the UI. */
export const prKey = (pr: { repo: string; number: number }) =>
  `${pr.repo.slice(pr.repo.indexOf("/") + 1)}#${pr.number}`;

/** Your open scoped PRs, through the local `gh` login. Callers put it in the store; see PRS_KEY. */
export const getMyOpenPRs = Effect.fn("github.getMyOpenPRs")(function* () {
  if (!enabled("github")) return [];
  const gh = yield* Gh;
  const nodes: (typeof Response.Type)["data"]["mine"]["nodes"][number][] = [];
  let after: string | null = null;
  let me = "";
  let total: number | undefined;
  do {
    const args: string[] = ["api", "graphql", "-f", `query=${QUERY}`, ...(after ? ["-f", `after=${after}`] : [])];
    const { viewer, mine }: (typeof Response.Type)["data"] = (yield* gh.json(args, Response)).data;
    me = viewer.login;
    total = mine.issueCount ?? total;
    nodes.push(...mine.nodes);
    after = mine.pageInfo.hasNextPage ? mine.pageInfo.endCursor : null;
  } while (after);
  yield* recordLimit("mine", total, nodes.length);
  return nodes.map((pr): PullRequest => {
    const [last] = pr.commits.nodes;
    const rollup = last ? last.commit.statusCheckRollup : null;
    return {
      repo: pr.repository.nameWithOwner,
      createdAt: new Date(pr.createdAt),
      people: reviewers(pr, me),
      approvedBy: approvers(pr.reviews.nodes),
      number: pr.number,
      title: pr.title,
      url: pr.url,
      branch: pr.headRefName,
      isDraft: pr.isDraft,
      updatedAt: new Date(pr.updatedAt),
      yourLastActivityAt: yourLastActivity(pr, me),
      review: pr.reviewDecision,
      state: pr.state,
      ...prChecks(rollup),
      stack: prStack(pr),
      changes: prChanges(pr),
      conflicts: pr.mergeable === "CONFLICTING",
      ...attention(pr.reviewThreads.nodes, pr.comments.nodes[0], me),
    };
  });
});

// Finished PRs keep a ticket's story: what landed or was closed. Keep the existing week of history.
const OTHER_PRS_QUERY = `query MondashMyOtherPRs($after: String) {
  search(query: "is:pr is:closed author:@me ${orgScope()} updated:>=DAYS sort:updated-desc", type: ISSUE, first: 30, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number title url state isDraft createdAt updatedAt headRefName mergedAt closedAt additions deletions changedFiles
      repository { nameWithOwner }
      commits(last: 1) { nodes { commit { ${CHECK_ROLLUP_FIELDS} } } }
    } }
  }
}`;

const OtherPRNode = Schema.Struct({
  ...changeFields,
  number: Schema.Finite,
  title: Schema.String,
  url: Schema.String,
  isDraft: Schema.Boolean,
  state: PRState,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  headRefName: Schema.String,
  mergedAt: Schema.NullOr(Schema.String),
  closedAt: Schema.NullOr(Schema.String),
  commits: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ commit: Schema.Struct({ statusCheckRollup: checkRollupSchema }) })),
  }),
  repository: Schema.Struct({ nameWithOwner: Schema.String }),
});
const decodeOtherPRNode = Schema.decodeUnknownResult(OtherPRNode);
const OtherPRResponse = Schema.Struct({
  data: Schema.Struct({
    search: Schema.Struct({ ...SearchCoverage, pageInfo: PageInfo, nodes: Schema.Array(AnyNode) }),
  }),
});

/** Your PRs merged or closed in the last week, as a ticket's finished work. */
export const getMyOtherPRs = Effect.fn("github.getMyOtherPRs")(function* () {
  if (!enabled("github")) return [];
  const gh = yield* Gh;
  const now = yield* Clock.currentTimeMillis;
  const since = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const nodes: (typeof OtherPRResponse.Type)["data"]["search"]["nodes"][number][] = [];
  let after: string | null = null;
  let total: number | undefined;
  do {
    const args: string[] = [
      "api",
      "graphql",
      "-f",
      `query=${OTHER_PRS_QUERY.replace("DAYS", since)}`,
      ...(after ? ["-f", `after=${after}`] : []),
    ];
    const { search }: (typeof OtherPRResponse.Type)["data"] = (yield* gh.json(args, OtherPRResponse, {
      maxBuffer: 8 * 1024 * 1024,
    })).data;
    total = search.issueCount ?? total;
    nodes.push(...search.nodes);
    after = search.pageInfo.hasNextPage ? search.pageInfo.endCursor : null;
  } while (after);
  yield* recordLimit("other-prs", total, nodes.length);
  return (yield* decodeNodes(decodeOtherPRNode, nodes)).flatMap((pr): PullRequest[] => {
    // GitHub's closed-date search can omit recently closed PRs. Search by update, then filter the actual finish date.
    const finishedAt = pr.mergedAt ?? pr.closedAt ?? pr.updatedAt;
    if (finishedAt.slice(0, 10) < since) return [];
    const [last] = pr.commits.nodes;
    const rollup = last ? last.commit.statusCheckRollup : null;
    return [
      {
        repo: pr.repository.nameWithOwner,
        createdAt: new Date(pr.createdAt),
        people: [],
        approvedBy: [],
        number: pr.number,
        title: pr.title,
        url: pr.url,
        branch: pr.headRefName,
        isDraft: pr.isDraft,
        updatedAt: new Date(finishedAt),
        review: pr.state === "MERGED" ? "MERGED" : null,
        state: pr.state,
        ...prChecks(rollup),
        changes: prChanges(pr),
        conflicts: false,
        reply: null,
        waitingBy: {},
        aiThreads: null,
      },
    ];
  });
});

const FEED_FIELDS = `... on PullRequest {
  number title url state isDraft createdAt headRefName bodyText reviewDecision additions deletions changedFiles
  ${STACK_FIELDS}
  author { login }
  repository { nameWithOwner }
  commits(last: 1) { nodes { commit { committedDate ${CHECK_ROLLUP_FIELDS} } } }
  comments(last: 20) { nodes { author { login } createdAt } }
  reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Team { slug } } } }
  timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 20) { nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { ... on User { login } ... on Team { slug } } } } }
  reviews(last: 50) { nodes { author { login __typename } state submittedAt url comments(last: 1) { nodes { url } } } }
  reviewThreads(last: 50) { nodes { isResolved comments(first: 20) { nodes { author { login __typename } createdAt ... on PullRequestReviewComment { url } } } } }
}`;

// Four searches in one request: asked of you, asked of your team, ones you have already reviewed, and open PRs
// that may ask any human (kept only when a human is requested: a PR waiting on a teammate is ready for you too).
const HUMANS_SEARCH = `is:open is:pr -is:draft ${orgScope()} -author:@me`;
const FEED_QUERY = (team: string) => `query MondashReviewDiscovery {
  viewer { login }
  requested: search(query: "is:open is:pr review-requested:@me", type: ISSUE, first: 25) { issueCount nodes { ... on PullRequest { id author { login } reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } } } } }
  team: search(query: "${team}", type: ISSUE, first: 25) { issueCount nodes { ... on PullRequest { id author { login } reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } } } } }
  reviewed: search(query: "is:open is:pr reviewed-by:@me", type: ISSUE, first: 25) { issueCount nodes { ... on PullRequest { id author { login } reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } } } } }
  humans: search(query: "${HUMANS_SEARCH}", type: ISSUE, first: 60) { issueCount nodes { ... on PullRequest { id author { login } reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } } } } }
}`;

const Reviewer = Schema.Struct({ login: Schema.optional(Schema.String), slug: Schema.optional(Schema.String) });
const FeedPRNode = Schema.Struct({
  ...stackFields,
  ...changeFields,
  number: Schema.Finite,
  title: Schema.String,
  url: Schema.String,
  isDraft: Schema.Boolean,
  state: PRState,
  createdAt: Schema.String,
  headRefName: Schema.String,
  bodyText: Schema.String,
  reviewDecision: Schema.NullOr(Schema.String),
  author: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  repository: Schema.Struct({ nameWithOwner: Schema.String }),
  commits: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({ commit: Schema.Struct({ committedDate: Schema.String, statusCheckRollup: checkRollupSchema }) }),
    ),
  }),
  comments: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({ author: Schema.NullOr(Schema.Struct({ login: Schema.String })), createdAt: Schema.String }),
    ),
  }),
  reviewRequests: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ requestedReviewer: Schema.NullOr(Reviewer) })),
  }),
  timelineItems: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        createdAt: Schema.optional(Schema.String),
        requestedReviewer: Schema.optional(Schema.NullOr(Reviewer)),
      }),
    ),
  }),
  reviews: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        author: Author,
        state: Schema.String,
        submittedAt: Schema.NullOr(Schema.String),
        url: Schema.optional(Schema.String),
        comments: Schema.optional(Schema.Struct({ nodes: Schema.Array(Schema.Struct({ url: Schema.String })) })),
      }),
    ),
  }),
  reviewThreads: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        isResolved: Schema.Boolean,
        comments: Schema.Struct({
          nodes: Schema.Array(
            Schema.Struct({ author: Author, createdAt: Schema.String, url: Schema.optional(Schema.String) }),
          ),
        }),
      }),
    ),
  }),
});
const decodeFeedPRNode = Schema.decodeUnknownResult(FeedPRNode);
const Search = Schema.Struct({ ...SearchCoverage, nodes: Schema.Array(AnyNode) });
const FeedResponse = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.Struct({ login: Schema.String }),
    requested: Search,
    team: Search,
    reviewed: Search,
    humans: Search,
  }),
});

const DiscoveryNode = Schema.Struct({
  id: Schema.String,
  author: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  reviewRequests: Schema.Struct({ nodes: Schema.Array(Schema.Struct({ requestedReviewer: Schema.NullOr(Reviewer) })) }),
});
const NodeId = Schema.Struct({ id: Schema.String });
const isNodeId = Schema.is(NodeId);
const DetailResponse = Schema.Struct({ data: Schema.Struct({ nodes: Schema.Array(Schema.NullOr(AnyNode)) }) });

/** Search cheaply, then fetch nested connections once per distinct PR, in bounded batches. */
const hydrateReviewSearches = Effect.fnUntraced(function* (data: typeof FeedResponse.Type.data) {
  const gh = yield* Gh;
  const searches = [data.requested, data.team, data.reviewed, data.humans];
  const eligible = new Set<string>();
  for (const search of searches) {
    for (const raw of search.nodes) {
      if (!isNodeId(raw)) continue;
      const pr = yield* Schema.decodeUnknownEffect(DiscoveryNode)(raw);
      if (pr.author?.login === data.viewer.login) continue;
      // The broad search previously discarded these only after fetching all their threads.
      if (search === data.humans && !pr.reviewRequests.nodes.some((r) => r.requestedReviewer?.login)) continue;
      eligible.add(pr.id);
    }
  }
  const ids = [...eligible];
  const byId = new Map<string, typeof AnyNode.Type>();
  for (let start = 0; start < ids.length; start += 20) {
    const query = `query MondashReviewDetails { nodes(ids: ${JSON.stringify(ids.slice(start, start + 20))}) { id ${FEED_FIELDS} } }`;
    const result = yield* gh.json(["api", "graphql", "-f", `query=${query}`], DetailResponse, {
      maxBuffer: 16 * 1024 * 1024,
    });
    for (const node of result.data.nodes) if (node && isNodeId(node)) byId.set(node.id, node);
  }
  const hydrate = (search: typeof data.requested) => ({
    ...search,
    nodes: search.nodes.flatMap((node) => {
      const found = isNodeId(node) ? byId.get(node.id) : undefined;
      return found ? [found] : [];
    }),
  });
  return {
    ...data,
    requested: hydrate(data.requested),
    team: hydrate(data.team),
    reviewed: hydrate(data.reviewed),
    humans: hydrate(data.humans),
  };
});

/** Other people's open PRs that have asked something of you, most urgent first. Stored under github-feed FEED_KEY. */
export const getReviewFeed = Effect.fn("github.getReviewFeed")(function* () {
  if (!enabled("github")) return { prs: [], seen: [] };
  const gh = yield* Gh;
  const searches = yield* Effect.forEach(
    teamQueries(),
    (team) =>
      gh.json(["api", "graphql", "-f", `query=${FEED_QUERY(team)}`], FeedResponse, { maxBuffer: 16 * 1024 * 1024 }),
    { concurrency: 2 },
  );
  yield* recordLimit(
    "reviews",
    searches.some(
      ({ data }) =>
        [data.requested, data.team, data.reviewed].some((s) => (s.issueCount ?? 0) > 25) ||
        (data.humans.issueCount ?? 0) > 60,
    )
      ? 1
      : 0,
    0,
  );
  const first = searches[0].data;
  const found = { ...first, team: { nodes: searches.flatMap((result) => result.data.team.nodes) } };
  const data = yield* hydrateReviewSearches(found);
  const me = data.viewer.login;
  const byUrl = new Map<string, FeedPR>();
  // The searches only decide which PRs to look at; each PR's own fields decide what it needs.
  for (const search of [data.requested, data.team, data.reviewed, data.humans]) {
    for (const pr of yield* decodeNodes(decodeFeedPRNode, search.nodes)) {
      // Your own PRs live in Resume; this column is other people's work.
      if (pr.author?.login === me) continue;
      // The broad search keeps only PRs where a person was asked. Bots and AI reviewers have no login in this query.
      if (search === data.humans && !pr.reviewRequests.nodes.some((r) => r.requestedReviewer?.login)) continue;
      const [lastCommit] = pr.commits.nodes;
      const rollup = lastCommit ? lastCommit.commit.statusCheckRollup : null;
      const about = `${pr.bodyText} ${pr.title} ${pr.headRefName}`;
      const existing = byUrl.get(pr.url);
      byUrl.set(pr.url, {
        key: `${pr.repository.nameWithOwner.slice(pr.repository.nameWithOwner.indexOf("/") + 1)}#${pr.number}`,
        // "core#2278", "core/pull/2278" and full links all name the same PR.
        links: [...new Set(Array.from(about.matchAll(/([\w.-]+)(?:#|\/pull\/)(\d+)/g), (m) => `${m[1]}#${m[2]}`))],
        tickets: [...new Set(Array.from(about.matchAll(/\b[A-Z]{2,5}-\d{2,6}\b/g), (m) => m[0].toUpperCase()))],
        url: pr.url,
        title: pr.title,
        repo: pr.repository.nameWithOwner,
        author: pr.author ? pr.author.login : "someone",
        branch: pr.headRefName,
        isDraft: pr.isDraft,
        state: pr.state,
        review: pr.reviewDecision,
        ...prChecks(rollup),
        stack: prStack(pr),
        changes: prChanges(pr),
        createdAt: new Date(pr.createdAt),
        lastCommitAt: lastCommit ? new Date(lastCommit.commit.committedDate) : new Date(pr.createdAt),
        reviews: pr.reviews.nodes.flatMap((r) =>
          r.author && r.submittedAt
            ? [
                {
                  author: r.author.login,
                  state: r.state,
                  at: new Date(r.submittedAt),
                  isBot: r.author.__typename === "Bot",
                  url: r.comments?.nodes.at(-1)?.url ?? r.url,
                },
              ]
            : [],
        ),
        threads: pr.reviewThreads.nodes.map((t) => ({
          isResolved: t.isResolved,
          comments: t.comments.nodes.flatMap((c) =>
            c.author
              ? [
                  {
                    author: c.author.login,
                    at: new Date(c.createdAt),
                    url: c.url ? c.url : pr.url,
                    isBot: c.author.__typename === "Bot",
                  },
                ]
              : [],
          ),
        })),
        // The PR's own list, not which search found it: the search index lags a few seconds behind an approval.
        // Asked of you, the devs team, or any human: once a person is asked, the PR is ready for your review too.
        requested: pr.reviewRequests.nodes.some(
          (r) =>
            r.requestedReviewer && (r.requestedReviewer.login !== undefined || teamMatches(r.requestedReviewer.slug)),
        ),
        // Your own comment counts as having seen it, so "I have looked, my review stands" is not read as silence.
        yourLastWordAt: lastWord(pr, me, existing),
        // When they last asked you, so a comment after the ask counts as answering it.
        requestedAt: requestedAt(pr.timelineItems.nodes, me, existing),
      });
    }
  }
  // The badges each row shows: open AI threads to action, and which people have looked at it.
  const all = [...byUrl.values()];
  return {
    prs: reviewFeed(all, me).map((pr) => ({
      ...pr,
      ai: aiThreads(pr),
      reviewedBy: humanReviewers(pr, me),
      yours: yourReview(pr, me),
    })),
    /** Every PR the searches returned, as reference keys. A session about one of these is not "unmatched", even
     * once you have reviewed it and it has left the column. */
    seen: all.map((pr) => `pr:${pr.repo}#${pr.key.slice(pr.key.indexOf("#") + 1)}`),
  };
});

// Checks, approvals and stack conflicts can change without changing the PR's updatedAt.
const PROBE_FIELDS = `url updatedAt isDraft mergeable mergeStateStatus reviewDecision
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts { totalCount checkRunCountsByState { state count } statusContextCountsByState { state count } } } } } }
  stack { number size entries(first: 100) { nodes { position pullRequest { number state isDraft mergeable mergeStateStatus reviewDecision } } } }
`;
const PROBE_QUERY = (team: string) => `query MondashProbe($after: String) {
  mine: search(query: "is:pr is:open author:@me ${orgScope()}", type: ISSUE, first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { ${PROBE_FIELDS} } }
  }
  requested: search(query: "is:open is:pr review-requested:@me", type: ISSUE, first: 25) { nodes { ... on PullRequest { ${PROBE_FIELDS} } } }
  team: search(query: "${team}", type: ISSUE, first: 25) { nodes { ... on PullRequest { ${PROBE_FIELDS} } } }
  reviewed: search(query: "is:open is:pr reviewed-by:@me", type: ISSUE, first: 25) { nodes { ... on PullRequest { ${PROBE_FIELDS} } } }
  humans: search(query: "${HUMANS_SEARCH}", type: ISSUE, first: 60) { nodes { ... on PullRequest { ${PROBE_FIELDS} } } }
}`;

/** A cheap fingerprint of your PRs and the ones asking for your review; it changes when any of them does. */
export const probeGitHub = Effect.fn("github.probe")(function* () {
  if (!enabled("github")) return [];
  const gh = yield* Gh;
  const response = Schema.Struct({
    data: Schema.Struct({
      mine: Schema.Struct({ nodes: Schema.Array(Schema.Unknown), pageInfo: PageInfo }),
      requested: Schema.Unknown,
      team: Schema.Unknown,
      reviewed: Schema.Unknown,
      humans: Schema.Unknown,
    }),
  });
  return yield* Effect.forEach(
    teamQueries(),
    (team) =>
      Effect.gen(function* () {
        const query = `query=${PROBE_QUERY(team)}`;
        const first = (yield* gh.json(["api", "graphql", "-f", query], response)).data;
        const nodes = [...first.mine.nodes];
        let after = first.mine.pageInfo.hasNextPage ? first.mine.pageInfo.endCursor : null;
        while (after) {
          const page = (yield* gh.json(["api", "graphql", "-f", query, "-f", `after=${after}`], response)).data.mine;
          nodes.push(...page.nodes);
          after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
        }
        return { ...first, mine: { nodes } };
      }),
    { concurrency: 2 },
  );
});

// Separate searches avoid unsupported boolean query dialects for multiple review teams.
const teamQueries = () =>
  profile.workspace.reviewTeams.length
    ? profile.workspace.reviewTeams.map(
        (team) => `is:open is:pr team-review-requested:${team.organization}/${team.slug}`,
      )
    : ["is:open is:pr review-requested:@me"];
