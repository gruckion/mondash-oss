import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  ActivityResponse,
  ActivityEntity,
  ActivityEvent,
  SectionResponse as SectionSchema,
  type Card,
  type SectionResponse,
} from "@mondash/shared/contract";
import { activityAttention, filterActivity } from "@mondash/shared/activity";
import { Schema } from "effect";
import { Store, storeKey } from "@/services/store";
import { readActivity, recordActivitySection } from "./activity";

const journalSchema = Schema.Struct({
  recordingSince: Schema.String,
  sections: Schema.Array(SectionSchema),
  entities: Schema.Array(ActivityEntity),
  events: Schema.Array(ActivityEvent),
});
const at = new Date().toISOString();
const card = (patch: Partial<Card> = {}): Card => ({
  id: "DEMO-1",
  title: "Fix billing",
  subtitle: "",
  status: "In Progress",
  kind: "issue",
  url: "https://linear.app/example/issue/DEMO-1/billing",
  updatedAt: at,
  attention: [],
  labels: [],
  links: [],
  related: [],
  sessions: [],
  ...patch,
});
const section = (cards: readonly Card[], patch: Partial<SectionResponse> = {}): SectionResponse => ({
  version: 1,
  section: "issues",
  generatedAt: at,
  updatedAt: at,
  stale: false,
  groups: [{ id: "mine", title: "Mine", collapsed: false, cards }],
  ...patch,
});
const run = <A, E>(program: Effect.Effect<A, E, Store>) =>
  Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(Store.layerMemory)));

test("a shared PR has one identity/history while both tickets remain filterable", async () => {
  await run(
    Effect.gen(function* () {
      const pr = {
        kind: "pr" as const,
        url: "https://github.com/example/core/pull/42",
        title: "Fix payment",
        reference: "core#42",
        updatedAt: new Date(Date.parse(at) + 1000).toISOString(),
        prState: "OPEN" as const,
      };
      yield* Effect.forEach(
        [
          section([
            card({ rows: [pr] }),
            card({ id: "DEMO-2", url: "https://linear.app/example/issue/DEMO-2/renewal", rows: [pr] }),
          ]),
          section(
            [
              card({
                id: "core#42",
                title: pr.title,
                kind: "review",
                url: pr.url,
                prState: "OPEN",
                reviewDecision: "REVIEW_REQUIRED",
              }),
            ],
            { section: "reviews" },
          ),
        ],
        recordActivitySection,
        { concurrency: "unbounded" },
      );
      const activity = yield* readActivity();
      const prs = activity.entities.filter((entity) => entity.source === "github");
      assert.equal(prs.length, 1);
      assert.ok(
        activityAttention(prs[0]).includes("Review requested"),
        "the full review card must retain its action when also linked as a PR row",
      );
      assert.equal(
        activity.events.filter((event) => event.entityId === prs[0].id && event.action === "Last updated").length,
        1,
      );
      for (const work of ["DEMO-1", "DEMO-2"])
        assert.deepEqual(
          [
            ...new Set(
              filterActivity(
                activity.events,
                activity.entities,
                { query: "payment", sources: ["github"], days: 7, work, needs: false },
                Date.now(),
              ).map((event) => event.entityId),
            ),
          ],
          [prs[0].id],
        );
    }),
  );
});

test("resolution clears current attention but preserves earlier changes and undated events", async () => {
  await run(
    Effect.gen(function* () {
      const pr = card({
        id: "core#42",
        kind: "review",
        url: "https://github.com/example/core/pull/42",
        prState: "OPEN",
        checks: "FAILURE",
        updatedAt: undefined,
      });
      yield* recordActivitySection(section([pr], { section: "reviews" }));
      const first = yield* readActivity();
      assert.ok(activityAttention(first.entities[0]).includes("Checks failed"));
      assert.equal(first.events[0].occurredAt, null);
      assert.equal(first.events[0].timeBasis, "unknown");
      yield* recordActivitySection(
        section([{ ...pr, prState: "MERGED", checks: "SUCCESS", status: "Merged" }], {
          section: "reviews",
          generatedAt: new Date(Date.parse(at) + 1000).toISOString(),
        }),
      );
      const merged = yield* readActivity();
      assert.deepEqual(activityAttention(merged.entities[0]), []);
      assert.ok(merged.events.some((event) => event.id === first.events[0].id));
      assert.ok(
        merged.events.some(
          (event) => event.action === "Change observed" && event.timeBasis === "observed" && event.occurredAt !== null,
        ),
      );
      assert.deepEqual(
        filterActivity(merged.events, merged.entities, { query: "", sources: [], days: 7, needs: true }, Date.now()),
        [],
      );
      yield* recordActivitySection(
        section([], { section: "reviews", generatedAt: new Date(Date.parse(at) + 2000).toISOString() }),
      );
      assert.equal((yield* readActivity()).entities[0].inCurrentWork, false);
    }),
  );
});

test("journal survives reopening SQLite, deduplicates refreshes and ignores late section responses", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mondash-activity-"));
  const file = join(dir, "history.sqlite");
  const inDatabase = async <A, E>(program: Effect.Effect<A, E, Store>) => {
    const db = new DatabaseSync(file);
    try {
      return await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(Store.layerDatabase(db))));
    } finally {
      db.close();
    }
  };
  try {
    const initial = await inDatabase(
      Effect.gen(function* () {
        yield* recordActivitySection(section([card()]));
        return yield* readActivity();
      }),
    );
    const reopened = await inDatabase(
      Effect.gen(function* () {
        yield* Effect.forEach([1, 2, 3], () => recordActivitySection(section([card()])), { concurrency: "unbounded" });
        yield* recordActivitySection(
          section([card({ title: "Old stale title" })], { generatedAt: new Date(Date.parse(at) - 1000).toISOString() }),
        );
        return yield* readActivity();
      }),
    );
    assert.deepEqual(reopened.events, initial.events);
    assert.equal(reopened.recordingSince, initial.recordingSince);
    assert.equal(reopened.entities[0].card.title, "Fix billing");
    assert.equal(Schema.is(ActivityResponse)(reopened), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unchanged work and inbox samples never alternate their state or grow item history", async () => {
  await run(
    Effect.gen(function* () {
      const issue = card();
      const notification = card({
        id: "linear-comment-42",
        kind: "notification",
        feedSource: "linear",
        status: "commented",
        unread: true,
      });
      const sample = (name: "issues" | "inbox", round: number) =>
        section(name === "issues" ? [issue] : [notification], {
          section: name,
          generatedAt: new Date(Date.parse(at) + round * 1000).toISOString(),
        });
      yield* recordActivitySection(sample("issues", 0));
      yield* recordActivitySection(sample("inbox", 0));
      const initial = yield* readActivity();
      for (let round = 1; round <= 5; round++) {
        yield* recordActivitySection(sample("issues", round));
        yield* recordActivitySection(sample("inbox", round));
      }
      const refreshed = yield* readActivity();
      assert.equal(
        refreshed.events.length,
        initial.events.length,
        "polling unchanged data must not create repeated history",
      );
      const work = refreshed.entities.find((entity) => entity.card.kind === "issue");
      assert.equal(work?.card.status, "In Progress", "a comment notification is not an issue status");
      assert.equal(work?.card.unread, undefined);
      assert.ok(
        refreshed.events.some((event) => event.action === "commented"),
        "the real inbox activity is retained separately",
      );
      for (const round of [10, 11])
        yield* recordActivitySection(
          section([card({ updatedAt: new Date(Date.parse(at) + round * 1000).toISOString() })], {
            generatedAt: new Date(Date.parse(at) + (round + 1) * 1000).toISOString(),
          }),
        );
      const later = yield* readActivity();
      assert.equal(
        later.events.filter((event) => event.entityId === work?.id && event.action === "Last updated").length,
        1,
        "timestamp-only samples update the snapshot rather than repeat the item",
      );
    }),
  );
});

test("upgrading a v1 journal removes fabricated observations and preserves source history across reads", async () => {
  await run(
    Effect.gen(function* () {
      yield* recordActivitySection(section([card()]));
      const initial = yield* readActivity();
      const store = yield* Store;
      yield* store.forget("activity:journal:v3");
      const legacyKey = storeKey(
        "activity:journal:v1",
        Schema.Struct({
          recordingSince: Schema.String,
          sections: Schema.Array(SectionSchema),
          entities: Schema.Array(ActivityEntity),
          events: Schema.Array(ActivityEvent),
        }),
      );
      yield* store.write(legacyKey, {
        recordingSince: initial.recordingSince,
        sections: [
          section([card()]),
          section(
            [card({ id: "comment-42", kind: "notification", feedSource: "linear", status: "commented", unread: true })],
            { section: "inbox" },
          ),
        ],
        entities: initial.entities,
        events: [
          ...initial.events,
          {
            id: "fake-transition",
            entityId: initial.entities[0].id,
            action: "Change observed",
            detail: "In Progress → commented",
            occurredAt: at,
            observedAt: at,
            timeBasis: "observed",
          },
        ],
      });
      const upgraded = yield* readActivity();
      assert.ok(upgraded.events.some((event) => event.id === initial.events[0].id));
      assert.equal(upgraded.events.length, initial.events.length + 1);
      assert.ok(upgraded.events.some((event) => event.action === "commented"));
      assert.equal(upgraded.recordingSince, initial.recordingSince);
      assert.deepEqual((yield* readActivity()).events, upgraded.events);
      yield* recordActivitySection(section([card()]));
      assert.deepEqual(
        [...(yield* readActivity()).events].sort((a, b) => a.id.localeCompare(b.id)),
        [...upgraded.events].sort((a, b) => a.id.localeCompare(b.id)),
      );
      assert.ok(
        (yield* store.read(legacyKey))?.value.events.some((event) => event.id === "fake-transition"),
        "legacy records remain recoverable",
      );
    }),
  );
});

test("linked sessions retain only their latest update without fabricating an issue change", async () => {
  await run(
    Effect.gen(function* () {
      const session = {
        id: "billing-session",
        tool: "codex" as const,
        title: "Billing investigation",
        updatedAt: at,
        canOpenOnMac: true,
        preview: "Investigating the billing guard.",
        running: true,
      };
      yield* recordActivitySection(section([card({ sessions: [session] })]));
      yield* recordActivitySection(
        section(
          [
            card({
              id: session.id,
              title: session.title,
              kind: "session",
              url: undefined,
              status: "Recent",
              sessions: [session],
            }),
          ],
          { section: "sessions" },
        ),
      );
      yield* recordActivitySection(
        section(
          [
            card({
              sessions: [
                {
                  ...session,
                  updatedAt: new Date(Date.parse(at) + 1000).toISOString(),
                  preview: "Checked verification cases.",
                  running: false,
                },
              ],
            }),
          ],
          {
            generatedAt: new Date(Date.parse(at) + 1000).toISOString(),
          },
        ),
      );
      const activity = yield* readActivity();
      const issue = activity.entities.find((entity) => entity.card.kind === "issue")!;
      const sessionEntity = activity.entities.find((entity) => entity.card.kind === "session")!;
      const sessionEvents = activity.events.filter((event) => event.entityId === sessionEntity.id);
      assert.equal(sessionEvents.length, 1, "each session has only its most recent entry");
      assert.equal(
        sessionEntity.card.sessions[0].preview,
        "Checked verification cases.",
        "an older standalone session cannot overwrite the newer linked preview",
      );
      assert.equal(sessionEvents[0].occurredAt, new Date(Date.parse(at) + 1000).toISOString());
      yield* recordActivitySection(
        section(
          [
            card({
              sessions: [
                {
                  ...session,
                  updatedAt: new Date(Date.parse(at) + 1000).toISOString(),
                  preview: "Checked verification cases.",
                  running: false,
                },
              ],
            }),
          ],
          { generatedAt: new Date(Date.parse(at) + 2000).toISOString() },
        ),
      );
      assert.deepEqual(
        (yield* readActivity()).events,
        activity.events,
        "unchanged sessions do not move or grow on refresh",
      );
      assert.equal(
        activity.events.filter((event) => event.entityId === issue.id).length,
        1,
        "an unchanged issue must not repeat the linked session's update",
      );
      assert.ok(
        activity.events.some(
          (event) => event.entityId === sessionEntity.id && event.detail === "Checked verification cases.",
        ),
        "the latest session update remains visible",
      );
    }),
  );
});

test("v2 upgrade collapses session output history and repairs hydrated Linear snapshots", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mondash-activity-upgrade-"));
  const db = new DatabaseSync(join(dir, "history.sqlite"));
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        const legacyKey = storeKey("activity:journal:v2", journalSchema);
        const updatedAt = new Date(Date.parse(at) + 1000).toISOString();
        const session = {
          id: "s",
          tool: "codex" as const,
          title: "Investigation",
          updatedAt,
          canOpenOnMac: true,
          preview: "Latest result",
        };
        const sections = [section([card()])];
        const legacy = {
          recordingSince: at,
          sections,
          entities: [
            {
              id: "ticket:DEMO-1",
              source: "linear" as const,
              card: card(),
              workIds: ["ticket:DEMO-1"],
              inCurrentWork: true,
            },
            {
              id: "session:codex:s",
              source: "codex" as const,
              card: card({ id: "s", kind: "session", sessions: [session], updatedAt: undefined }),
              workIds: ["ticket:DEMO-1"],
              inCurrentWork: true,
            },
          ],
          events: [
            {
              id: "undated",
              entityId: "ticket:DEMO-1",
              action: "Last updated",
              occurredAt: null,
              observedAt: at,
              timeBasis: "unknown" as const,
            },
            {
              id: "old-session",
              entityId: "session:codex:s",
              action: "Session activity",
              occurredAt: at,
              observedAt: at,
              timeBasis: "source" as const,
              detail: "Earlier output",
            },
            {
              id: "session-change",
              entityId: "session:codex:s",
              action: "Change observed",
              occurredAt: new Date(Date.parse(updatedAt) + 1000).toISOString(),
              observedAt: new Date(Date.parse(updatedAt) + 1000).toISOString(),
              timeBasis: "observed" as const,
              detail: "Latest result",
            },
          ],
        };
        yield* store.write(legacyKey, legacy);
        const activity = yield* readActivity();
        assert.equal(activity.events.length, 2);
        const latest = activity.events.find((e) => e.entityId === "session:codex:s")!;
        assert.equal(latest.detail, "Latest result");
        assert.equal(latest.occurredAt, updatedAt);
        const issue = activity.events.find((e) => e.entityId === "ticket:DEMO-1")!;
        assert.equal(issue.occurredAt, at);
        assert.equal(issue.timeBasis, "source");
        assert.deepEqual((yield* readActivity()).events, activity.events);
        assert.deepEqual((yield* store.read(legacyKey))?.value, legacy, "the previous journal stays recoverable");
      }).pipe(Effect.scoped, Effect.provide(Store.layerDatabase(db))),
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a ticket first seen without metadata acquires its real timestamp when hydrated", async () => {
  await run(
    Effect.gen(function* () {
      yield* recordActivitySection(section([card({ updatedAt: undefined, title: "DEMO-1", status: "" })]));
      yield* recordActivitySection(section([card()], { generatedAt: new Date(Date.parse(at) + 1000).toISOString() }));
      const activity = yield* readActivity();
      assert.ok(
        activity.events.every((e) => e.occurredAt !== null),
        "a placeholder snapshot must not remain undated after hydration",
      );
      assert.equal(activity.events.find((e) => e.action === "Last updated")?.occurredAt, at);
    }),
  );
});
