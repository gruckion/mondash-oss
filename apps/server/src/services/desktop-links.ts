import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Context, Data, Effect, Layer } from "effect";
import { desktopLinkProvider } from "@mondash/shared/desktop-link";
import { slackThreadUrl } from "@mondash/shared/slack-thread-url";
import { linearAppUrl, notionAppUrl, slackAppUrl } from "@/lib/app-urls";
import { mySlackTeam, myWorkspace } from "@/lib/slack-web";
import { SlackApi } from "./slack";
import { Store } from "./store";

type Dependencies = {
  platform: string;
  workspace: Effect.Effect<{ team: string; url: string } | undefined>;
  launch: (bundle: string, url: string, signal: AbortSignal) => Promise<void>;
};

class DesktopLaunchFailed extends Data.TaggedError("DesktopLaunchFailed")<{ readonly cause: unknown }> {}

/** LaunchServices resolves installed apps, including apps outside /Applications. A refusal means use the web. */
export const makeDesktopLinkOpener = ({ platform, workspace, launch }: Dependencies) =>
  Effect.fn("DesktopLinks.open")(function* (value: string) {
    if (platform !== "darwin") return false;
    const provider = desktopLinkProvider(value);
    if (!provider) return false;
    let url: string;
    let bundle: string;
    if (provider === "linear") {
      url = linearAppUrl(value);
      bundle = "com.linear";
    } else if (provider === "notion") {
      url = notionAppUrl(value);
      bundle = "notion.id";
    } else {
      const account = yield* workspace.pipe(
        Effect.timeout("2 seconds"),
        Effect.orElseSucceed(() => undefined),
      );
      // Never send another workspace's message to the connected account's team.
      if (!account || !URL.canParse(account.url) || new URL(account.url).hostname !== new URL(value).hostname)
        return false;
      url = slackAppUrl(slackThreadUrl(value), account.team);
      bundle = "com.tinyspeck.slackmacgap";
    }
    if (url === value) return false;
    return yield* Effect.tryPromise({
      try: (signal) => launch(bundle, url, signal),
      catch: (cause) => new DesktopLaunchFailed({ cause }),
    }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  });

export class DesktopLinks extends Context.Service<DesktopLinks, { open(url: string): Effect.Effect<boolean> }>()(
  "mondash/server/DesktopLinks",
) {
  static readonly layer = Layer.effect(
    DesktopLinks,
    Effect.gen(function* () {
      const store = yield* Store;
      const slack = yield* SlackApi;
      const workspace = Effect.gen(function* () {
        const team = yield* mySlackTeam();
        const url = yield* myWorkspace();
        return team && url ? { team, url } : undefined;
      }).pipe(Effect.provideService(Store, store), Effect.provideService(SlackApi, slack));
      return DesktopLinks.of({
        open: makeDesktopLinkOpener({
          platform: process.platform,
          workspace,
          launch: async (bundle, url, signal) => {
            await promisify(execFile)("/usr/bin/open", ["-b", bundle, url], { signal, timeout: 3_000 });
          },
        }),
      });
    }),
  );
}
