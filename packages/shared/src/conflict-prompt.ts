// Repair instructions shared by remote agent sessions and the desktop prompt sheet.

export type ConflictPR = { url: string; repo: string; branch: string };

export function conflictPrompt(
  pr: ConflictPR,
  related: ConflictPR[],
  ticket: string | undefined,
  folder: string,
): string {
  const others = related.filter((r) => r.url !== pr.url);
  return [
    `Fix the merge conflicts on ${pr.url} (branch \`${pr.branch}\`)${ticket ? ` for ${ticket}` : ""}. Work through it without stopping to ask.`,
    "Before changing files, use GitHub to recheck the PR's state, author, mergeability, headRefName and baseRefName. Compare the author with the authenticated GitHub user. Only repair this user's open PRs. Wait and recheck if mergeability is UNKNOWN. If this PR is closed, belongs to someone else, or is no longer CONFLICTING, stop and explain without changing it.",
    others.length
      ? `Related PRs for the same work. Bring these up to date too, because generated types must match across repos:\n${others.map((r) => `- ${r.url} (branch \`${r.branch}\`)`).join("\n")}`
      : "Check whether this work has related PRs in other repositories and bring those up to date too.",
    `Rules:
1. Each branch has a worktree under ${folder}/. Find the repository checkout and its worktree by branch name; if there is none, clone the repository if needed and create an isolated worktree there from the PR head branch. Read the repository instructions first. Preserve unrelated working changes.
2. Recheck ownership and open state for every related PR before changing it. Fetch, then merge each PR’s actual baseRefName from its base repository into its head branch. Do not assume the base branch is main or that origin points at the base repository. Never rebase: reviewers have already seen these commits, and a rebase breaks "changes since last review". Never force push.
3. Get the conflicting files from git yourself. Before resolving, read the incoming change on the base branch (which PR, and why) so its behaviour is kept.
4. For migration conflicts, follow the repository’s migration ordering and regeneration instructions. Do not hand-merge generated migration metadata.
5. Never hand-edit generated files (including API schemas and client types). Regenerate them with the repository’s scripts once their source is up to date. If they then contain changes that are not from our work, that repo is behind its base branch: merge its latest base branch into it too.
6. Read the open review comments on the PRs, so the resolution does not undo something a reviewer asked for.
7. Run the tests and type check in every repo you changed, especially tests that touch the conflicted files. Behaviour must not change.
8. Commit the merge and push, without force.`,
  ].join("\n\n");
}

export type Reviewers = { coderabbit: boolean; greptile: boolean };

/** Adds the step that asks the AI reviewers to review again, after the push. */
export function withReviewers(prompt: string, reviewers: Reviewers): string {
  const comments = [
    reviewers.coderabbit && "`@coderabbitai review`",
    reviewers.greptile && "`@greptileai review`",
  ].filter(Boolean);
  if (comments.length === 0)
    return `${prompt}\n\nFinish with a short summary: what conflicted, how you resolved it, the tests you ran and what you pushed.`;
  return `${prompt}
9. After pushing, leave a comment on each PR you pushed to, so the AI reviewers review again: ${comments.join(" and ")} (one comment each).

Finish with a short summary: what conflicted, how you resolved it, the tests you ran and what you pushed.`;
}

/** The Codex app link that opens a new thread in the configured folder with this prompt. */
export function codexUrl(prompt: string, folder: string): string {
  return `codex://threads/new?${new URLSearchParams({ path: folder, prompt })}`;
}
