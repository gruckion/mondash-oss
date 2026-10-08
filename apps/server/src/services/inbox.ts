import { Context, Effect, Layer } from "effect";
import type { ServerConfig } from "@/config";
import { buildFeed, FEED_KEY, notifyNew, refreshPushSources, setRead } from "@/lib/feed";
import { type ActionFailure, SourceFailure, toActionFailure } from "./errors";
import type { Gh } from "./gh";
import type { Linear } from "./linear";
import type { Mcp } from "./mcp";
import type { SlackApi } from "./slack";
import { Store } from "./store";

/** Everything meant for you, from GitHub, Linear, Slack and Notion (see lib/feed.ts). */
export class Inbox extends Context.Service<
  Inbox,
  {
    /** Your read or unread choice; a Slack DM also moves Slack's own read marker. */
    markRead(id: string, read: boolean): Effect.Effect<void, ActionFailure>;
    /** Fetches GitHub and Linear notifications, rebuilds the Inbox and sends a phone alert for anything new. */
    refreshAndNotify: Effect.Effect<void, SourceFailure>;
  }
>()("mondash/server/Inbox") {
  static readonly layer = Layer.effect(
    Inbox,
    Effect.gen(function* () {
      const store = yield* Store;
      const context = yield* Effect.context<Store | Mcp | Gh | SlackApi | ServerConfig | Linear>();
      return Inbox.of({
        markRead: (id, read) =>
          setRead(id, read).pipe(
            Effect.provideContext(context),
            Effect.mapError(toActionFailure("markRead", "Could not change the read state. Try again.")),
            Effect.withSpan("Inbox.markRead", { attributes: { id, read } }),
          ),
        refreshAndNotify: refreshPushSources.pipe(
          Effect.andThen(store.refresh(FEED_KEY, buildFeed())),
          Effect.flatMap(notifyNew),
          Effect.provideContext(context),
          Effect.mapError((cause) => new SourceFailure({ source: "inbox", cause })),
          Effect.withSpan("Inbox.refreshAndNotify"),
        ),
      });
    }),
  );
}
