/** Only GitHub PR routes identify a PR; preserve file/comment anchors when opening the original link. */
export function pullRequestIdentity(href: string) {
  try {
    const url = new URL(href);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return undefined;
    const match = url.pathname.match(/^\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)(?:\/|$)/);
    if (!match) return undefined;
    const number = Number(match[2]);
    if (!Number.isSafeInteger(number)) return undefined;
    const repo = match[1]!;
    return { repo, number, url: `https://github.com/${repo}/pull/${number}`, key: `${repo.toLowerCase()}#${number}` };
  } catch {
    return undefined;
  }
}
