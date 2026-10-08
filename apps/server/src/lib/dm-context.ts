// Picking the part of a Slack DM that Jev should read. No "@/" imports, so tests can import it.

export type DmMessage = { user: string; text: string; ts: string };

// Work talk: PR and ticket links, repo names, review words. Personal chat is dropped before Jev sees it.
const WORK =
  /\b(pr|pull request|review(ed|s)?|approv(e|ed|al)|merge[ds]?|conflicts?|deploy|ship(ped)?|branch|ticket|[a-z]{2,6}-\d+|core|web|technician|portal|video|screens?|tests?|testing|bug|fix(ed|es)?)\b|github\.com|linear\.app/i;

// Enough context for Jev to see a topic and its answer, at about 550 tokens.
const KEEP = 26;
const TAIL = 6;
const CHARS = 200;

/**
 * The messages worth sending: work talk with one neighbour each side, plus the last few whatever they say,
 * so a short "checking" still counts as an answer. Newest last.
 */
export function dmContext(messages: DmMessage[], me: string): string[] {
  const work = messages.map((m) => WORK.test(m.text));
  const tail = messages.length - TAIL;
  return messages
    .filter((_, i) => work[i] || work[i - 1] || work[i + 1] || i >= tail)
    .slice(-KEEP)
    .map((m) => `${m.user === me ? "you" : "them"}: ${m.text.replace(/\s+/g, " ").slice(0, CHARS)}`);
}

/** A Slack permalink for a message, so the badge opens the DM at the right place. */
export const dmPermalink = (workspace: string, channel: string, ts: string) =>
  `${workspace}archives/${channel}/p${ts.replace(".", "")}`;
