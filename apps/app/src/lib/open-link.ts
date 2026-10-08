import { desktopLinkProvider } from "@mondash/shared/desktop-link";
import { slackThreadUrl } from "@mondash/shared/slack-thread-url";

type LinkEnvironment = {
  platform: string;
  macDesktop: boolean;
  openNative: (url: string) => Promise<void>;
  openWeb: (url: string) => void;
  openDesktop: (url: string) => Promise<{ opened: boolean }>;
  openFallback: (url: string) => void;
};

/** Keep phone universal links intact; only desktop Mac clicks ask the Mac to launch a provider app. */
export async function openExternalLink(value: string, env: LinkEnvironment): Promise<void> {
  if (!value.startsWith("https://") || !URL.canParse(value))
    throw new Error("This link is not a supported web address.");
  const url = slackThreadUrl(value);
  if (env.platform !== "web") {
    await env.openNative(url);
  } else if (env.macDesktop && desktopLinkProvider(url)) {
    try {
      if ((await env.openDesktop(url)).opened) return;
    } catch {
      // An older or unreachable backend must leave the web link usable.
    }
    env.openFallback(url);
  } else {
    env.openWeb(url);
  }
}
