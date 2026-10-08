import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Layer } from "effect";
import { Schema } from "effect";
import { DebriefRange } from "@mondash/shared/contract";
import { Store } from "@/services/store";
import { SlackApi, SlackFailure } from "@/services/slack";
import { classification, collectDebrief, priority } from "./debrief";

test("only confident exclusions hide threads; uncertain or incomplete evidence stays visible", () => {
  assert.equal(classification({ noise: 0.95, action: 0.05 }).category, "noise");
  assert.equal(classification({ resolved: 0.9 }).category, "resolved");
  assert.equal(classification({ noise: 0.7, action: 0.3 }).category, "uncertain");
  assert.equal(classification({ noise: 0.99 }, true).category, "uncertain");
  assert.equal(classification({}).category, "uncertain");
  assert.ok(priority({ category: "action", urgency: "today" }) < priority({ category: "action", urgency: "soon" }));
});

test("debrief rejects reversed and unbounded periods", () => {
  const valid = Schema.is(DebriefRange);
  assert.equal(valid({ since: "2026-09-25T00:00:00Z", until: "2026-09-30T08:00:00Z" }), true);
  assert.equal(valid({ since: "2026-09-30T00:00:00Z", until: "2026-09-25T08:00:00Z" }), false);
  assert.equal(valid({ since: "2026-01-01T00:00:00Z", until: "2026-09-25T08:00:00Z" }), false);
});

test("Slack collection follows cursors, resumes a failed page and deduplicates", async () => {
  const range = { since: "2026-09-25T00:00:00Z", until: "2026-09-30T08:00:00Z" };
  const hit = {
    channel_id: "C1",
    message_ts: String(Date.parse("2026-09-26T12:00:00Z") / 1000),
    content: "Please review",
    permalink: "https://slack.test/one",
  };
  const calls: string[] = [];
  let fail = true;
  const api = SlackApi.of({
    get: () => Effect.die("not used"),
    post: (_method, form) =>
      Effect.suspend(() => {
        calls.push(form.cursor ?? "");
        if (form.cursor && fail) {
          fail = false;
          return Effect.fail(new SlackFailure({ method: "search", error: "ratelimited" }));
        }
        return Effect.succeed({
          results: { messages: [hit] },
          response_metadata: { next_cursor: form.cursor ? "" : "next" },
        });
      }),
  });
  const items = await Effect.runPromise(
    Effect.gen(function* () {
      yield* collectDebrief(range, () => Effect.void).pipe(Effect.ignore);
      return yield* collectDebrief(range, () => Effect.void);
    }).pipe(Effect.provide(Store.layerMemory), Effect.provideService(SlackApi, api)),
  );
  assert.equal(items.length, 1);
  assert.deepEqual(calls, ["", "next", "next"]);
});

test("billing refusal fails generation instead of presenting an unfiltered report as Jev output", async () => {
  const { recoverJev } = await import("./debrief");
  const { JevFailure } = await import("./jev");
  await assert.rejects(
    Effect.runPromise(recoverJev(new JevFailure({ status: 402, message: "No credits" }))),
    /no TypeSafe API credits/,
  );
  assert.deepEqual(
    await Effect.runPromise(recoverJev(new JevFailure({ status: 503, message: "Temporarily unavailable" }))),
    {},
  );
});

test("topic grouping cannot lose, invent or duplicate source evidence", async () => {
  const { coversSources } = await import("./debrief");
  assert.equal(coversSources(["a", "b"], [["a", "b"]]), true);
  assert.equal(coversSources(["a", "b"], [["a"]]), false);
  assert.equal(coversSources(["a", "b"], [["a", "b", "b"]]), false);
  assert.equal(coversSources(["a", "b"], [["a", "x"]]), false);
  assert.equal(coversSources(["a"], [[], ["a"]]), false);
});

test("an explicit retry can recover immediately after credits are restored", async () => {
  const { cachedDecision } = await import("./debrief");
  const { storeKey } = await import("@/services/store");
  const { JevFailure } = await import("./jev");
  await Effect.runPromise(
    Effect.gen(function* () {
      const key = storeKey("test-jev", Schema.Record(Schema.String, Schema.Finite));
      yield* cachedDecision(key, Effect.fail(new JevFailure({ status: 402, message: "No credits" }))).pipe(
        Effect.ignore,
      );
      assert.deepEqual(yield* cachedDecision(key, Effect.succeed({ action: 0.9 })), { action: 0.9 });
      assert.deepEqual(yield* cachedDecision(key, Effect.die("successful verdict must be cached")), { action: 0.9 });
    }).pipe(Effect.provide(Layer.mergeAll(Store.layerMemory, (await import("effect")).Logger.layer([])))),
  );
});
