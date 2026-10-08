import { Duration, Effect } from "effect";
import { notionPeople, notionRowMetadata } from "@/lib/notion-rows";
import { Mcp } from "@/services/mcp";
import type { Person } from "@mondash/shared/contract";

/**
 * A Notion doc's assignees, reviewers, estimate and created / edited times, for the web and the phone alike.
 * The workspace's people are read once a day; the page every five minutes.
 */
export const notionDoc = Effect.fn("notion-doc.notionDoc")(function* (id: string) {
  const mcp = yield* Mcp;
  const [page, people] = yield* Effect.all(
    [
      mcp.cachedCall("notion", "notion-fetch", { id }, Duration.minutes(5)),
      mcp.cachedCall("notion", "notion-get-users", {}, Duration.days(1)).pipe(
        Effect.flatMap((text) => Effect.try(() => notionPeople(JSON.parse(text)))),
        Effect.orElseSucceed(() => new Map<string, Person>()),
      ),
    ],
    { concurrency: "unbounded" },
  );
  return yield* Effect.try(() => notionRowMetadata(JSON.parse(page), people));
});
