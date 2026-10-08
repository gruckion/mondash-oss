import { existsSync } from "node:fs";
import { Effect } from "effect";
import { homedir } from "node:os";
import { join } from "node:path";
import { linearAppUrl, notionAppUrl, slackAppUrl } from "@/lib/app-urls";
import { mySlackTeam } from "@/lib/slack-web";

// The dashboard runs on your Mac, so it can check which desktop apps are installed. A browser cannot.
const installed = (name: string) =>
  ["/Applications", join(homedir(), "Applications")].some((dir) => existsSync(join(dir, `${name}.app`)));
const HAS = { notion: installed("Notion"), slack: installed("Slack"), linear: installed("Linear") };

/** Each link opens in the desktop app if it is installed, else in the browser. */
export const notionHref = (url: string, title?: string) => (HAS.notion ? notionAppUrl(url, title) : url);
export const linearHref = (url: string) => (HAS.linear ? linearAppUrl(url) : url);

export const slackHref = Effect.fn("app-links.slackHref")(function* (url: string) {
  if (!HAS.slack) return url;
  const team = yield* mySlackTeam();
  return team ? slackAppUrl(url, team) : url;
});
