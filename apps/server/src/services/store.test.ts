import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Data, Deferred, Effect, Fiber, Logger, Schema } from "effect";
import { TestClock } from "effect/testing";
import { CacheRevision, ForceRefresh, ReadOnly, Store, storeKey } from "./store";

class SourceDown extends Data.TaggedError("SourceDown")<{ readonly retryAfter?: number }> {}

const KEY = storeKey("test:value", Schema.String);

/** A fetch that fails while `down` is set, counting its calls. */
const source = () => {
  const state: { calls: number; down?: SourceDown } = { calls: 0 };
  const fetch = Effect.suspend(() => {
    state.calls++;
    return state.down ? Effect.fail(state.down) : Effect.succeed(`answer ${state.calls}`);
  });
  return { state, fetch };
};

/** Lets the background refresh, a fiber forked by a fiber, run to its end. */
const settle = Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, { discard: true });

const run = <A, E>(program: Effect.Effect<A, E, Store>) =>
  program.pipe(
    Effect.scoped,
    Effect.provide([Store.layerMemory, TestClock.layer(), Logger.layer([])]),
    Effect.runPromise,
  );

test("cached does not refresh a failing key again before its backoff passes", async () => {
  const { state, fetch } = source();
  await run(
    Effect.gen(function* () {
      const store = yield* Store;
      assert.equal(yield* store.cached(KEY, "1 minute", fetch), "answer 1");

      state.down = new SourceDown({});
      yield* TestClock.adjust("2 minutes");
      assert.equal(yield* store.cached(KEY, "1 minute", fetch), "answer 1");
      yield* settle;
      assert.equal(state.calls, 2);

      yield* TestClock.adjust("2 minutes");
      assert.equal(yield* store.cached(KEY, "1 minute", fetch), "answer 1");
      yield* settle;
      assert.equal(state.calls, 2, "no new try inside the 3 minute backoff");

      state.down = undefined;
      yield* TestClock.adjust("2 minutes");
      yield* store.cached(KEY, "1 minute", fetch);
      yield* settle;
      assert.equal(state.calls, 3);
      assert.equal(yield* store.cached(KEY, "1 minute", fetch), "answer 3");
    }),
  );
});

test("cached waits for a failure's retryAfter, and a missing key fails without fetching meanwhile", async () => {
  const { state, fetch } = source();
  await run(
    Effect.gen(function* () {
      const store = yield* Store;
      state.down = new SourceDown({ retryAfter: 600 });
      assert.equal((yield* Effect.flip(store.cached(KEY, "1 minute", fetch)))._tag, "SourceDown");

      yield* TestClock.adjust("5 minutes");
      assert.equal((yield* Effect.flip(store.cached(KEY, "1 minute", fetch)))._tag, "StoreFailure");
      assert.equal(state.calls, 1);

      state.down = undefined;
      yield* TestClock.adjust("6 minutes");
      assert.equal(yield* store.cached(KEY, "1 minute", fetch), "answer 2");
    }),
  );
});

/** A source whose first fetch reads its value, then waits for `release`. Later fetches answer at once. */
const slowSource = Effect.gen(function* () {
  const release = yield* Deferred.make<void>();
  const state = { value: "old", calls: 0 };
  const fetch = Effect.suspend(() => {
    state.calls++;
    const seen = state.value;
    return state.calls === 1 ? Deferred.await(release).pipe(Effect.as(seen)) : Effect.succeed(seen);
  });
  return { state, fetch, release: Deferred.succeed(release, undefined) };
});

for (const { how, forced } of [
  {
    how: "the force option",
    forced: (store: Store["Service"], fetch: Effect.Effect<string>) => store.refresh(KEY, fetch, { force: true }),
  },
  {
    how: "ForceRefresh",
    forced: (store: Store["Service"], fetch: Effect.Effect<string>) =>
      store.refresh(KEY, fetch).pipe(Effect.provideService(ForceRefresh, true)),
  },
]) {
  test(`a forced refresh (${how}) does not join a fetch from before the change, and stores the new value`, async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* Store;
        const { state, fetch, release } = yield* slowSource;
        const before = yield* Effect.forkChild(store.refresh(KEY, fetch));
        yield* settle;
        const joined = yield* Effect.forkChild(store.refresh(KEY, fetch));
        yield* settle;

        state.value = "new";
        assert.equal(yield* forced(store, fetch), "new");
        yield* release;
        assert.equal(yield* Fiber.join(before), "old", "the old fetch still answers its caller");
        assert.equal(yield* Fiber.join(joined), "new");
        assert.equal(state.calls, 2, "a plain refresh joins the running fetch");
        assert.equal((yield* store.read(KEY))?.value, "new");
      }),
    );
  });
}

test("forget and forgetPrefix during a refresh are not undone by it", async () => {
  await run(
    Effect.gen(function* () {
      const store = yield* Store;
      for (const forget of [store.forget(KEY.name), store.forgetPrefix("test:")]) {
        yield* store.write(KEY, "stored");
        const { fetch, release } = yield* slowSource;
        const running = yield* Effect.forkChild(store.refresh(KEY, fetch));
        yield* settle;
        yield* forget;
        yield* release;
        assert.equal(yield* Fiber.join(running), "old");
        assert.equal(yield* store.read(KEY), undefined);
      }
    }),
  );
});

test("a request failing under the old login cannot restore retry delays after reconnection", async () => {
  await run(
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.write(KEY, "saved snapshot");
      const release = yield* Deferred.make<void>();
      const old = yield* Effect.forkChild(
        store
          .refresh(KEY, Deferred.await(release).pipe(Effect.andThen(Effect.fail(new SourceDown({})))))
          .pipe(Effect.result),
      );
      yield* settle;
      yield* store.retryPrefix("test:");
      assert.equal((yield* store.read(KEY))?.value, "saved snapshot");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(old);
      assert.equal(yield* store.refresh(KEY, Effect.succeed("fresh snapshot")), "fresh snapshot");
    }),
  );
});

test("a read-only request answers from the store however old, and fetches only what was never stored", async () => {
  const { state, fetch } = source();
  await run(
    Effect.gen(function* () {
      const store = yield* Store;
      const readOnly = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provideService(ReadOnly, true));
      assert.equal(yield* readOnly(store.cached(KEY, "1 minute", fetch)), "answer 1");

      yield* TestClock.adjust("1 hour");
      assert.equal(yield* readOnly(store.cached(KEY, "1 minute", fetch)), "answer 1");
      yield* settle;
      assert.equal(state.calls, 1, "no refresh from a read-only request");

      assert.equal(yield* store.cached(KEY, "1 minute", fetch), "answer 1");
      yield* settle;
      assert.equal(state.calls, 2, "the background loop still refreshes");
    }),
  );
});

test("refresh does not fetch a failing key again before its backoff passes, unless forced", async () => {
  const { state, fetch } = source();
  await run(
    Effect.gen(function* () {
      const store = yield* Store;
      assert.equal(yield* store.refresh(KEY, fetch), "answer 1");
      state.down = new SourceDown({ retryAfter: 300 });
      assert.equal((yield* Effect.flip(store.refresh(KEY, fetch)))._tag, "SourceDown");

      state.down = undefined;
      yield* TestClock.adjust("1 minute");
      assert.equal(yield* store.refresh(KEY, fetch), "answer 1", "the stored value, with no fetch");
      assert.equal(state.calls, 2);

      assert.equal(yield* store.refresh(KEY, fetch, { force: true }), "answer 3");
    }),
  );
});

test("a write of an unchanged value moves only its time", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    await Effect.gen(function* () {
      const store = yield* Store;
      yield* store.write(KEY, "same");
      db.exec("CREATE TABLE rewrites (key TEXT)");
      db.exec("CREATE TRIGGER counted AFTER UPDATE OF value ON cache BEGIN INSERT INTO rewrites VALUES (new.key); END");
      yield* TestClock.adjust("1 minute");
      yield* store.write(KEY, "same");
      assert.equal((yield* store.storedAt(KEY.name))?.getTime(), 60_000);
      assert.deepEqual(db.prepare("SELECT key FROM rewrites").all(), []);

      yield* store.write(KEY, "changed");
      assert.equal(db.prepare("SELECT key FROM rewrites").all().length, 1);
      assert.equal((yield* store.read(KEY))?.value, "changed");
    }).pipe(
      Effect.scoped,
      Effect.provide([Store.layerDatabase(db), TestClock.layer(), Logger.layer([])]),
      Effect.runPromise,
    );
  } finally {
    db.close();
  }
});

// A late old-process write must not enter a restarted process with a different account/scope.
test("configuration revisions isolate cached work while retaining explicit read state", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const obtain = (revision: string) =>
      Effect.runPromise(
        Store.pipe(
          Effect.provide(Store.layerDatabase(db)),
          Effect.provideService(CacheRevision, revision),
          Effect.scoped,
        ),
      );
    const old = await obtain("old-account"),
      current = await obtain("new-account");
    const work = storeKey("github:my-open-prs:v4", Schema.String),
      read = storeKey("feed:read", Schema.String);
    await Effect.runPromise(old.write(work, "old account work"));
    await Effect.runPromise(old.write(read, "explicit read state"));
    assert.equal(await Effect.runPromise(current.read(work)), undefined);
    assert.equal((await Effect.runPromise(current.read(read)))?.value, "explicit read state");
    await Effect.runPromise(current.write(work, "new account work"));
    assert.equal((await Effect.runPromise(current.read(work)))?.value, "new account work");
    await Effect.runPromise(old.write(work, "late stale work"));
    assert.equal(
      await Effect.runPromise(current.read(work)),
      undefined,
      "late results carry their originating account revision",
    );
    assert.equal(await Effect.runPromise(current.storedAt(work.name)), undefined);
  } finally {
    db.close();
  }
});

test("an existing three-column cache migrates its scope and keeps historical read state", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, at INTEGER NOT NULL)");
    const put = db.prepare("INSERT INTO cache VALUES (?,?,?)");
    put.run("github:my-open-prs:v4", JSON.stringify("migrated work"), 1000);
    put.run("feed:read", JSON.stringify("read state"), 1000);
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        assert.equal((yield* store.read(storeKey("github:my-open-prs:v4", Schema.String)))?.value, "migrated work");
        assert.equal((yield* store.read(storeKey("feed:read", Schema.String)))?.value, "read state");
      }).pipe(
        Effect.provide(Store.layerDatabase(db)),
        Effect.provideService(CacheRevision, "migrated-scope"),
        Effect.scoped,
      ),
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM cache WHERE revision = ?").get("migrated-scope")?.count, 2);
  } finally {
    db.close();
  }
});
