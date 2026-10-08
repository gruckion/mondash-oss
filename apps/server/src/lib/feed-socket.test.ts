import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { Store } from "@/services/store";
import { addSlackThreadOfMine, slackThreadsOfMine } from "./feed";

test("threads you posted in are kept in the store, newest first, once each", async () => {
  const threads = await Effect.gen(function* () {
    for (const thread of ["1.1", "2.2", "1.1"]) yield* addSlackThreadOfMine(thread);
    return yield* slackThreadsOfMine;
  }).pipe(Effect.provide(Store.layerMemory), Effect.runPromise);
  assert.deepEqual(threads, ["1.1", "2.2"]);
});
