import { profile } from "../profile";
import { Schema } from "effect";
import { refKeys } from "./refs.ts";

/** Why a review cannot start, in words for the person. Thrown by the resolver and failed with by its Effect host. */
export class ReviewScopeError extends Schema.TaggedError<ReviewScopeError>()("ReviewScopeError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export type ReviewScope = { urls: string[]; cwd: string; title: string; notReady: string[] };
export type ReviewScopePR = {
  url: string;
  title: string;
  body: string;
  branch: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  comments: string[];
  /** Ready for human review: see `readyForReview`. A related PR that is not ready stays out of the review. */
  ready: boolean;
};

const AI_REVIEWERS = new Set(["copilot", "coderabbitai", "greptile-apps"]);

/**
 * A PR is ready for human review when it is not a draft and a review is requested from the devs team or
 * from any human. Requested AI reviewers do not count. A PR you have already reviewed stays ready, so a
 * re-review still finds it.
 */
export function readyForReview(
  pr: {
    draft: boolean;
    requestedReviewers: ReadonlyArray<{ login: string; type: string }>;
    requestedTeams: ReadonlyArray<{ slug: string }>;
  },
  reviewedByMe: boolean,
): boolean {
  if (pr.draft) return false;
  if (reviewedByMe) return true;
  if (
    pr.requestedTeams.some((team) => profile.workspace.reviewTeams.some((configured) => configured.slug === team.slug))
  )
    return true;
  return pr.requestedReviewers.some(
    (user) => user.type !== "Bot" && !user.login.endsWith("[bot]") && !AI_REVIEWERS.has(user.login.toLowerCase()),
  );
}
export type ReviewScopeDependencies = {
  /** Server-owned current review feed, including its established multi-PR groups. */
  groups: () => Promise<ReadonlyArray<ReadonlyArray<{ readonly url: string }>>>;
  load: (url: string) => Promise<ReviewScopePR>;
  forTicket: (ticket: string, owner: string) => Promise<string[]>;
  cwd: (owner: string, repository?: string) => Promise<string>;
};

export function parseReviewPRUrl(
  value: string,
): { url: string; owner: string; repo: string; number: number } | undefined {
  try {
    const parsed = new URL(value);
    const match = parsed.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "github.com" ||
      parsed.port ||
      parsed.username ||
      parsed.password ||
      !match
    )
      return;
    const [, owner, repo, number] = match;
    if (!Number.isSafeInteger(Number(number))) return;
    return { url: `https://github.com/${owner}/${repo}/pull/${number}`, owner, repo, number: Number(number) };
  } catch {
    return;
  }
}

/** Explicit PR references only: full links, owner/repo#123 or repo#123 (within the selected org). */
export function relatedPRUrls(text: string, owner: string): string[] {
  const urls = new Set<string>();
  for (const match of text.matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*\b/g)) {
    const parsed = parseReviewPRUrl(match[0]);
    if (parsed?.owner.toLowerCase() === owner.toLowerCase()) urls.add(parsed.url);
  }
  for (const match of text.matchAll(/(?<![\w./-])(?:([\w.-]+)\/)?([\w.-]+)#([1-9]\d*)\b/g)) {
    if (match[1] && match[1].toLowerCase() !== owner.toLowerCase()) continue;
    const parsed = parseReviewPRUrl(`https://github.com/${owner}/${match[2]}/pull/${match[3]}`);
    if (parsed) urls.add(parsed.url);
  }
  return [...urls];
}

export function reviewTicketIds(text: string): string[] {
  return refKeys(text)
    .filter((key) => profile.workspace.ticketPrefixes.some((prefix) => key.startsWith(`ticket:${prefix}-`)))
    .map((key) => key.slice(7));
}

/**
 * Resolve at tap time. Only open PRs in the same org join the review: old merged PRs often appear as
 * historical comparisons. Follow descriptions and every comment, then shared Linear tickets. Never
 * accept a directory, prompt or executable from the phone. Fail rather than silently truncate a group.
 */
export function createReviewScopeResolver(deps: ReviewScopeDependencies) {
  return async (value: string): Promise<ReviewScope> => {
    const selected = parseReviewPRUrl(value);
    if (!selected) throw new ReviewScopeError({ message: "Choose a valid GitHub pull request from Reviews." });
    const identity = (url: string) => url.toLowerCase();
    const groups = await deps.groups();
    const group = groups.find((prs) =>
      prs.some((pr) => {
        const parsed = parseReviewPRUrl(pr.url);
        return parsed !== undefined && identity(parsed.url) === identity(selected.url);
      }),
    );
    if (!group)
      throw new ReviewScopeError({
        message: "This pull request is no longer in Reviews. Refresh the list and try again.",
      });
    const cwd = await deps.cwd(selected.owner, selected.repo);
    const pending = [selected.url, ...group.map((pr) => pr.url)];
    const seen = new Set<string>();
    const tickets = new Set<string>();
    const prs: ReviewScopePR[] = [];
    const notReady: string[] = [];
    while (pending.length) {
      const parsed = parseReviewPRUrl(pending.shift()!);
      if (!parsed || parsed.owner.toLowerCase() !== selected.owner.toLowerCase() || seen.has(identity(parsed.url)))
        continue;
      seen.add(identity(parsed.url));
      if (seen.size > 60)
        throw new ReviewScopeError({ message: "Too many linked pull requests to safely start one review." });
      const pr = await deps.load(parsed.url);
      const canonical = parseReviewPRUrl(pr.url);
      if (!canonical || identity(canonical.url) !== identity(parsed.url))
        throw new ReviewScopeError({ message: "GitHub returned an unexpected pull request." });
      if (pr.state !== "OPEN") {
        if (identity(parsed.url) === identity(selected.url))
          throw new ReviewScopeError({ message: "This pull request is already closed. Refresh Reviews." });
        continue;
      }
      // The PR that was tapped always joins. A related one joins only when it is ready for human review; one
      // that is not is named in the prompt so the review leaves it alone, and its links are not followed.
      if (!pr.ready && identity(parsed.url) !== identity(selected.url)) {
        notReady.push(canonical.url);
        continue;
      }
      prs.push({ ...pr, url: canonical.url });
      if (prs.length > 20)
        throw new ReviewScopeError({
          message: "More than 20 related pull requests were found. Start this review on your Mac.",
        });
      pending.push(...relatedPRUrls([pr.body, ...pr.comments].join("\n"), selected.owner));
      // Ticket mentions in discussion can be incidental; use PR metadata to establish ticket ownership.
      for (const ticket of reviewTicketIds(`${pr.title}\n${pr.branch}\n${pr.body}`)) {
        if (tickets.has(ticket)) continue;
        tickets.add(ticket);
        pending.push(...(await deps.forTicket(ticket, selected.owner)));
      }
    }
    return { urls: prs.map((pr) => pr.url), cwd, title: prs[0].title, notReady };
  };
}
