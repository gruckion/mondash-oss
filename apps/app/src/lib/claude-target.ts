/** iPad desktop browsing identifies as a Mac, so exclude touch-capable Mac user agents. */
export const isMacBrowser = (userAgent: string, maxTouchPoints: number) =>
  /Macintosh|Mac OS X/.test(userAgent) && !/iPhone|iPad|iPod/.test(userAgent) && maxTouchPoints < 2;
export type ClaudeTarget = "terminal" | "claude-desktop";
export const readClaudeTarget = (value: string | null): ClaudeTarget =>
  value === "terminal" ? "terminal" : "claude-desktop";
