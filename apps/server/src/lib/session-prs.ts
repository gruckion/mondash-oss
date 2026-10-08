import { Effect, Schema } from "effect";
import { SessionPullRequest, type SessionPullRequests } from "@mondash/shared/contract";
import { pullRequestIdentity } from "@mondash/shared/session-prs";
import { Gh } from "@/services/gh";
import { Store, storeKey } from "@/services/store";
import { ActionError } from "./action-error";
import { enabled } from "../profile";
import type { AgentSession } from "./sessions";
import { CHECK_ROLLUP_FIELDS, checkRollupSchema, prChecks } from "./github-checks";

const Response = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        pullRequest: Schema.NullOr(
          Schema.Struct({
            title: Schema.String,
            headRefName: Schema.String,
            state: Schema.Literals(["OPEN", "MERGED", "CLOSED"]),
            isDraft: Schema.Boolean,
            updatedAt: Schema.String,
            additions: Schema.Int,
            deletions: Schema.Int,
            changedFiles: Schema.Int,
            author: Schema.NullOr(Schema.Struct({ login: Schema.String, avatarUrl: Schema.String })),
            commits: Schema.Struct({
              nodes: Schema.Array(Schema.Struct({ commit: Schema.Struct({ statusCheckRollup: checkRollupSchema }) })),
            }),
          }),
        ),
      }),
    ),
  }),
});
// Reuse bounded CI metadata to retire old reruns and exclude review-only checks.
const QUERY = `query MondashSessionPR($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
    title headRefName state isDraft updatedAt additions deletions changedFiles
    author { login avatarUrl }
    commits(last: 1) { nodes { commit { ${CHECK_ROLLUP_FIELDS} } } }
  } }
}`;

/** Native associated PRs first, followed by explicit references from the transcript. */
export function sessionPRIdentities(session: Pick<AgentSession, "refs" | "linkedPRs">) {
  const identities = new Map<string, NonNullable<ReturnType<typeof pullRequestIdentity>>>();
  for (const ref of [...(session.linkedPRs ?? []), ...Object.keys(session.refs)]) {
    const match = ref.match(/^pr:([\w.-]+\/[\w.-]+)#([1-9]\d*)$/);
    const identity = match ? pullRequestIdentity(`https://github.com/${match[1]}/pull/${match[2]}`) : undefined;
    if (identity) identities.set(identity.key, identity);
  }
  return [...identities.values()];
}

/** Full-session references, not just the visible tail. Metadata and failures share the GitHub cache across sessions. */
export const pullRequestsForSession = Effect.fn("sessions.pullRequests")(function* (
  session: Pick<AgentSession, "refs" | "linkedPRs">,
): Effect.fn.Return<SessionPullRequests, never, Store | Gh> {
  const identities = sessionPRIdentities(session);
  const store = yield* Store;
  const gh = yield* Gh;
  const prs = yield* Effect.forEach(
    identities.slice(0, 30),
    (identity): Effect.Effect<SessionPullRequest> => {
      const base = { url: identity.url, repo: identity.repo, number: identity.number };
      const key = storeKey(`github:session-pr:${identity.key}:v2`, SessionPullRequest);
      const fetch = Effect.gen(function* () {
        const [owner, repo] = identity.repo.split("/");
        const response = yield* gh.json(
          [
            "api",
            "graphql",
            "-f",
            `query=${QUERY}`,
            "-f",
            `owner=${owner}`,
            "-f",
            `repo=${repo}`,
            "-F",
            `number=${identity.number}`,
          ],
          Response,
        );
        const pr = response.data.repository?.pullRequest;
        if (!pr) return yield* Effect.fail(new ActionError("Pull request unavailable"));
        const checks = prChecks(pr.commits.nodes[0]?.commit.statusCheckRollup ?? null);
        return {
          ...base,
          title: pr.title,
          branch: pr.headRefName,
          state: pr.state === "OPEN" && pr.isDraft ? ("DRAFT" as const) : pr.state,
          updatedAt: pr.updatedAt,
          ...(pr.author ? { author: { name: pr.author.login, avatar: pr.author.avatarUrl } } : {}),
          changes: { additions: pr.additions, deletions: pr.deletions, files: pr.changedFiles },
          ...(checks.checks ? { checks: checks.checks } : {}),
          ...(checks.checksSummary ? { checksSummary: checks.checksSummary } : {}),
        };
      });
      if (!enabled("github")) return Effect.succeed({ ...base, unavailable: true });
      return store
        .cached(key, "3 minutes", fetch)
        .pipe(Effect.catch(() => Effect.succeed({ ...base, unavailable: true })));
    },
    { concurrency: 3 },
  );
  return {
    prs: prs.sort(
      (a, b) => Number(b.state === "OPEN" || b.state === "DRAFT") - Number(a.state === "OPEN" || a.state === "DRAFT"),
    ),
    truncated: identities.length > 30,
  };
});
