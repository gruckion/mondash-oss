import { Context, Effect, Layer } from "effect";
import type { LinkInput, LinkResult } from "@mondash/shared/contract";
import type { ServerConfig } from "@/config";
import { linkSlackThread } from "@/lib/dashboard-actions";
import { type ActionFailure, toActionFailure } from "./errors";
import type { Gh } from "./gh";
import type { Linear } from "./linear";
import type { Mcp } from "./mcp";
import type { SlackApi } from "./slack";
import type { Store } from "./store";

/** Linear tickets: link the Slack thread a ticket came from, after Jev checks it belongs. */
export class Tickets extends Context.Service<
  Tickets,
  { linkSlackThread(input: LinkInput): Effect.Effect<LinkResult, ActionFailure> }
>()("mondash/server/Tickets") {
  static readonly layer = Layer.effect(
    Tickets,
    Effect.gen(function* () {
      const context = yield* Effect.context<ServerConfig | Mcp | SlackApi | Store | Linear | Gh>();
      return Tickets.of({
        linkSlackThread: (input) =>
          linkSlackThread(input).pipe(
            Effect.provideContext(context),
            Effect.mapError(
              toActionFailure("linkSlackThread", "Could not link the thread. Check Linear and Slack on your Mac."),
            ),
            Effect.withSpan("Tickets.linkSlackThread", { attributes: { ticketId: input.ticketId } }),
          ),
      });
    }),
  );
}
