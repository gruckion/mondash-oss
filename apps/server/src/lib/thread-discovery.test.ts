import assert from "node:assert/strict";
import { test } from "node:test";
import { Data, Deferred, Effect, Logger, Schema } from "effect";
import { TestClock } from "effect/testing";
import { Store } from "@/services/store";
import { makeThreadDiscovery, slackThreadIdentity, THREADS_KEY, unattachedThreads } from "./thread-discovery.ts";
import { issueGroups } from "./presenters.ts";
import { SectionResponse } from "@mondash/shared/contract";
import type { ActiveTicket, UnlinkedThread } from "./resume.ts";

const at = new Date("2026-09-24T12:00:00.000Z");
const parent = "https://examplehq.slack.com/archives/C123/p1789747637478879";
const reply = "https://examplehq.slack.com/archives/C123/p1789750000000000?thread_ts=1789747637.478879&cid=C123";
const other = "https://examplehq.slack.com/archives/C123/p1789750000000001";
const thread: UnlinkedThread = {
  url: parent,
  href: "slack://channel",
  channel: "#eng",
  from: "Morgan Park",
  text: "DEMO-123: Apply <https://example.com|this fix>",
  replyCount: 2,
  participants: ["Taylor Reed", "Morgan Park"],
  lastAt: at,
};
const ticket: ActiveTicket = {
  id: "DEMO-123",
  title: "Fix billing",
  url: "https://linear.app/example/issue/DEMO-123",
  status: "Started",
  statusType: "started",
  priority: { value: 1, name: "Urgent" },
  attachments: [],
  updatedAt: at.toISOString(),
  prs: [],
  otherPRs: [],
  sessions: [],
  slack: [],
  notion: [],
  reply: null,
  assigned: { at },
};
type Found = Map<string, UnlinkedThread[]>;
class SlackDown extends Data.TaggedError("SlackDown") {}
type Discovery = Effect.Success<ReturnType<typeof makeThreadDiscovery<SlackDown, never>>>;

/** A test with a discovery whose Slack search is `find`, over an in-memory store and a test clock. */
const withDiscovery = <A, E>(
  find: (tickets: ReadonlyArray<ActiveTicket>) => Effect.Effect<Found, SlackDown>,
  body: (discovery: Discovery) => Effect.Effect<A, E, Store>,
) =>
  Effect.gen(function* () {
    return yield* body(yield* makeThreadDiscovery(find));
  }).pipe(Effect.scoped, Effect.provide([Store.layerMemory, TestClock.layer(), Logger.layer([])]));

/** Lets the background scan run. */
const settle = Effect.gen(function* () {
  for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
});

test("discovered Slack rows are the only link affordance and preserve context", () => {
  const resume = {
    sections: [{ title: "Active", collapsed: false, tickets: [ticket] }],
    otherPRs: [],
    labelColours: {},
  };
  const empty = issueGroups(resume)[0].cards[0];
  assert.equal(empty.linkTicketId, undefined);
  assert.equal(
    empty.rows?.some((row) => row.linkTicketId),
    false,
  );
  const groups = issueGroups(resume, new Map([[ticket.id, [thread]]]));
  Schema.decodeSync(SectionResponse)({
    version: 1,
    section: "issues",
    generatedAt: at.toISOString(),
    updatedAt: at.toISOString(),
    stale: false,
    groups,
    threadsState: "ready",
  });
  const row = groups[0].cards[0].rows?.[0];
  assert.equal(row?.linkTicketId, "DEMO-123");
  assert.equal(row?.title, "#eng");
  assert.equal(row?.subtitle, "Morgan P: DEMO-123: Apply this fix");
  assert.equal(row?.updatedAt, at.toISOString());
  assert.equal(row?.badges?.[0].text, "2 replies · Taylor R, Morgan P");
  const linkedTicket = {
    ...ticket,
    attachments: [{ url: parent, title: "Existing thread" }],
    slack: [{ url: parent, href: "slack://channel", title: "Existing thread" }],
  };
  const linked = issueGroups(
    { ...resume, sections: [{ ...resume.sections[0], tickets: [linkedTicket] }] },
    new Map([[ticket.id, [thread, { ...thread, url: reply }]]]),
  )[0].cards[0];
  assert.equal(linked.rows?.length, 1);
  assert.equal(linked.rows?.[0].linkTicketId, undefined);
});

test("thread identity excludes attached parent/reply variants and duplicate candidates", () => {
  assert.equal(slackThreadIdentity(parent), slackThreadIdentity(reply));
  assert.equal(slackThreadIdentity("file:///archives/C123/p1789747637478879"), undefined);
  assert.deepEqual(
    unattachedThreads({ ...ticket, attachments: [{ url: reply, title: "Attached reply" }] }, [thread]),
    [],
  );
  assert.deepEqual(
    unattachedThreads({ ...ticket, attachments: [{ url: parent, title: "Attached parent" }] }, [
      { ...thread, url: reply },
    ]),
    [],
  );
  const result = unattachedThreads(ticket, [
    thread,
    { ...thread, url: reply },
    { ...thread, channel: "@private", url: other },
  ]);
  assert.deepEqual(
    result.map((entry) => entry.url),
    [parent],
  );
});

test("reads never search; the refresh searches once in the background and stores JSON arrays", async () => {
  let calls = 0;
  const result = await Effect.gen(function* () {
    const pending = yield* Deferred.make<Found, SlackDown>();
    return yield* withDiscovery(
      () => Effect.suspend(() => (calls++, Deferred.await(pending))),
      (discovery) =>
        Effect.gen(function* () {
          const before = yield* discovery.snapshot([ticket]);
          yield* discovery.refresh([ticket]);
          yield* discovery.refresh([ticket]);
          yield* settle;
          const running = yield* discovery.snapshot([ticket]);
          yield* Deferred.succeed(pending, new Map([[ticket.id, [thread]]]));
          yield* settle;
          const stored = yield* (yield* Store).read(THREADS_KEY);
          return { before, running, after: yield* discovery.snapshot([ticket]), stored: stored?.value.entries };
        }),
    );
  }).pipe(Effect.runPromise);
  assert.deepEqual(result.before, { entries: [], state: "loading" });
  assert.deepEqual(result.running, { entries: [], state: "loading" });
  assert.equal(result.after.state, "ready");
  assert.equal(result.after.entries[0][1][0].url, parent);
  assert.ok(Array.isArray(result.stored));
  assert.equal(calls, 1);
});

test("stale discovery retains candidates, reports failures and retries after backoff", async () => {
  let fail = false;
  let calls = 0;
  const states = await withDiscovery(
    () =>
      Effect.suspend(() => {
        calls++;
        return fail ? Effect.fail(new SlackDown()) : Effect.succeed(new Map([[ticket.id, [thread]]]));
      }),
    (discovery) =>
      Effect.gen(function* () {
        const seen: Array<[string, number, number]> = [];
        const look = Effect.gen(function* () {
          yield* settle;
          const snapshot = yield* discovery.snapshot([ticket]);
          seen.push([snapshot.state, snapshot.entries.length, calls]);
        });
        yield* discovery.refresh([ticket]);
        yield* look;
        fail = true;
        yield* TestClock.adjust("59 minutes");
        yield* discovery.refresh([ticket]);
        yield* look;
        yield* TestClock.adjust("1 minute");
        yield* discovery.refresh([ticket]);
        yield* look;
        yield* discovery.refresh([ticket]);
        yield* look;
        yield* TestClock.adjust("30 seconds");
        fail = false;
        yield* discovery.refresh([ticket]);
        yield* look;
        return seen;
      }),
  ).pipe(Effect.runPromise);
  assert.deepEqual(states, [
    ["ready", 1, 1],
    ["ready", 1, 1],
    ["error", 1, 2],
    ["error", 1, 2],
    ["ready", 1, 3],
  ]);
});

test("late pre-link scans cannot overwrite discovery for updated attachments", async () => {
  const result = await Effect.gen(function* () {
    const old = yield* Deferred.make<Found, SlackDown>();
    const current = yield* Deferred.make<Found, SlackDown>();
    let calls = 0;
    const linked = { ...ticket, attachments: [{ title: "New attachment", url: reply }] };
    return yield* withDiscovery(
      () => Deferred.await(++calls === 1 ? old : current),
      (discovery) =>
        Effect.gen(function* () {
          yield* discovery.refresh([ticket]);
          yield* settle;
          yield* discovery.refresh([linked]);
          yield* settle;
          const loading = yield* discovery.snapshot([linked]);
          yield* Deferred.succeed(current, new Map());
          yield* settle;
          yield* Deferred.succeed(old, new Map([[ticket.id, [thread]]]));
          yield* settle;
          const stored = yield* (yield* Store).read(THREADS_KEY);
          return { loading, after: yield* discovery.snapshot([linked]), stored: stored?.value.entries };
        }),
    );
  }).pipe(Effect.runPromise);
  assert.equal(result.loading.state, "loading");
  assert.deepEqual(result.after, { entries: [], state: "ready" });
  assert.deepEqual(result.stored, []);
});

test("no tickets returns ready without making discovery calls", async () => {
  let calls = 0;
  const snapshot = await withDiscovery(
    () => Effect.sync(() => (calls++, new Map())),
    (discovery) =>
      Effect.gen(function* () {
        yield* discovery.refresh([]);
        yield* settle;
        return yield* discovery.snapshot([]);
      }),
  ).pipe(Effect.runPromise);
  assert.deepEqual(snapshot, { entries: [], state: "ready" });
  assert.equal(calls, 0);
});
