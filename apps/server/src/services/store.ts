import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { profile } from "../profile";
import { Cause, Clock, Context, Duration, Effect, Fiber, Layer, Schema, type Scope } from "effect";
import { causeText } from "./errors";
import { withIoSpan } from "@/tracing";

/**
 * The dashboard's own store: one SQLite file holding every API and MCP payload, with when it was fetched. It survives
 * restarts, so a reload costs nothing, and a source being down shows the last known answer.
 * ponytail: one table, whole payloads as JSON text; add per-source tables only if you want to query inside them.
 */

/** Reading or writing the store failed. */
export class StoreFailure extends Schema.TaggedError<StoreFailure>()("StoreFailure", {
  key: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message() {
    return `Store ${this.key}: ${causeText(this.cause)}`;
  }
}

/** A key and the schema of what is stored under it. A key ending in `:v<n>` is versioned (see `write`). */
export interface StoreKey<A> {
  readonly name: string;
  readonly codec: Schema.Codec<A, unknown>;
}

/** Declares a key. The value is stored as the schema's JSON, so Dates and other non-JSON values round-trip. */
export const storeKey = <A>(name: string, schema: Schema.Codec<A, unknown>): StoreKey<A> => ({
  name,
  codec: Schema.toCodecJson(schema),
});

export type Stored<A> = { readonly value: A; readonly at: Date };

/**
 * While true, `refresh` acts as `refresh(key, fetch, { force: true })`. For callers that reach `refresh` through code
 * they do not own, as a live rebuild does. The fetch itself runs without it.
 */
export const ForceRefresh = Context.Reference<boolean>("mondash/server/Store/ForceRefresh", {
  defaultValue: () => false,
});

/**
 * While true, `cached` answers from the store and never starts a refresh, whatever the age. The app's requests run
 * with it, so how often providers are asked does not depend on how many screens poll; one background loop refreshes
 * the sections instead (`Dashboard.warm`). A key with nothing stored is still fetched.
 */
export const ReadOnly = Context.Reference<boolean>("mondash/server/Store/ReadOnly", {
  defaultValue: () => false,
});

// Each process writes with its startup scope. Late old-scope writes cannot become new-scope cache hits.
export const CacheRevision = Context.Reference<string>("mondash/server/Store/CacheRevision", {
  defaultValue: () =>
    createHash("sha256")
      .update(
        JSON.stringify({
          directory: profile.directory,
          workspace: profile.workspace,
          notion: profile.notion,
          github: profile.integrations.github,
          linear: profile.integrations.linear,
          slack: profile.integrations.slack,
          sessions: profile.integrations.sessions,
          classification: profile.integrations.classification,
        }),
      )
      .digest("hex"),
});
const scopedKey = (name: string) =>
  !/^(health:|github:cooldown:|session-file:|sessions:recent:|debrief:archive:|debrief:report:|debrief:jobs:|feed:read$|feed:seen$|feed:since$|feed:slack-read$|assigned:)/.test(
    name,
  );
const FILE = join(".cache", "mondash.db");
const FIRST_BACKOFF = Duration.toMillis(Duration.minutes(3));
const MAX_BACKOFF = Duration.toMillis(Duration.minutes(30));
// "resume:v3" -> "resume:v": a key whose payload shape is versioned.
const VERSION = /^(.*:v)\d+$/;

export class Store extends Context.Service<
  Store,
  {
    /** What is stored for the key. Data that no longer fits the key's schema counts as nothing stored. */
    read<A>(key: StoreKey<A>): Effect.Effect<Stored<A> | undefined, StoreFailure>;
    write<A>(key: StoreKey<A>, value: A): Effect.Effect<void, StoreFailure>;
    /** When the key was last stored, whatever its value is. */
    storedAt(name: string): Effect.Effect<Date | undefined, StoreFailure>;
    /**
     * Stale-while-revalidate: a value younger than `fresh` is returned as it is, an older one is returned now and
     * refreshed in the background, and a missing one is fetched. When that fetch fails, the newest copy of an earlier
     * version of the key stands in, so a source being down after a version bump shows the last answer, not an error.
     * After a failed refresh the key is not fetched again until its backoff passes (see `makeStore`).
     */
    cached<A, E, R>(
      key: StoreKey<A>,
      fresh: Duration.Input,
      fetch: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | StoreFailure, R>;
    /**
     * Fetches and stores. Callers share one fetch per key, and the fetch finishes even when they stop waiting.
     * A failed fetch leaves the old value. While a failed key's backoff runs, it answers with the stored value without
     * fetching, or fails when nothing is stored. `force` is for when the source is known to have changed: it ignores
     * the backoff, does not join a fetch that started before, and that fetch's result is not stored.
     */
    refresh<A, E, R>(
      key: StoreKey<A>,
      fetch: Effect.Effect<A, E, R>,
      options?: { readonly force?: boolean },
    ): Effect.Effect<A, E | StoreFailure, R>;
    /** Drops a key, so the next read fetches again. A fetch of it already running does not store its result. */
    forget(name: string): Effect.Effect<void, StoreFailure>;
    /** Drops every key that starts with `prefix`, for example all of one server's calls. */
    forgetPrefix(prefix: string): Effect.Effect<void, StoreFailure>;
    /** After a provider reconnects, allow its failed keys to retry without deleting their saved data. */
    retryPrefix(prefix: string): Effect.Effect<void>;
    /** Deletes the keys that start with `prefix` and were stored more than `age` ago. Returns how many. */
    prune(prefix: string, age: Duration.Input): Effect.Effect<number, StoreFailure>;
  }
>()("mondash/server/Store") {
  /** The store in `.cache/mondash.db`, relative to where the server runs. */
  static readonly layer = Layer.effect(
    Store,
    storeIn(() => {
      mkdirSync(dirname(FILE), { recursive: true, mode: 0o700 });
      chmodSync(dirname(FILE), 0o700);
      const database = new DatabaseSync(FILE);
      chmodSync(FILE, 0o600);
      database.exec("PRAGMA journal_mode = WAL");
      return database;
    }),
  );

  /** An empty store in memory, for tests. */
  static readonly layerMemory = Layer.effect(
    Store,
    storeIn(() => new DatabaseSync(":memory:")),
  );

  /** A store in a database the caller opened and closes, for tests that look at its rows. */
  static readonly layerDatabase = (db: DatabaseSync) =>
    Layer.effect(
      Store,
      Effect.gen(function* () {
        return makeStore(db, yield* Effect.scope, yield* CacheRevision);
      }),
    );
}

/** A store in the database `open` opens, closed with the layer. */
function storeIn(open: () => DatabaseSync) {
  return Effect.gen(function* () {
    const db = yield* Effect.acquireRelease(Effect.sync(open), (database) => Effect.sync(() => database.close()));
    return makeStore(db, yield* Effect.scope, yield* CacheRevision);
  });
}

/** The seconds a failure asks to wait before the next try, as a Slack 429's Retry-After does. */
const retryAfter = (error: unknown) =>
  typeof error === "object" && error !== null && "retryAfter" in error && typeof error.retryAfter === "number"
    ? error.retryAfter
    : undefined;

function makeStore(db: DatabaseSync, scope: Scope.Scope, revision: string) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, at INTEGER NOT NULL, revision TEXT)",
  );
  const columns = db.prepare("PRAGMA table_info(cache)").all();
  if (!columns.some((column) => column.name === "revision")) {
    // Bind the existing cache to the migrated install's unchanged scope once.
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("ALTER TABLE cache ADD COLUMN revision TEXT");
      db.prepare("UPDATE cache SET revision = ?").run(revision);
      db.exec("COMMIT");
    } catch (cause) {
      db.exec("ROLLBACK");
      throw cause;
    }
  }

  const attempt = <A>(key: string, run: () => A) =>
    Effect.try({ try: run, catch: (cause) => new StoreFailure({ key, cause }) });

  const read = <A>(key: StoreKey<A>) =>
    Effect.gen(function* () {
      const found = yield* attempt(key.name, () => {
        const row = db.prepare("SELECT value, at, revision FROM cache WHERE key = ?").get(key.name);
        return row &&
          (!scopedKey(key.name) || row.revision === revision) &&
          typeof row.value === "string" &&
          typeof row.at === "number"
          ? { json: row.value, at: row.at }
          : undefined;
      });
      if (!found) return undefined;
      return yield* Schema.decodeEffect(Schema.fromJsonString(key.codec))(found.json).pipe(
        Effect.map((value): Stored<A> | undefined => ({ value, at: new Date(found.at) })),
        // Data written by older code under the same key: treat it as missing, so it is fetched again.
        Effect.catch((issue) =>
          Effect.logWarning(`Stored ${key.name} no longer fits its schema; fetching it again`, issue).pipe(
            Effect.as(undefined),
          ),
        ),
      );
    });

  /**
   * Writes unless `current` says no. It is asked right before the row changes, with no yield in between. An unchanged
   * value only moves its time, which is what freshness reads.
   */
  const writeIf = <A>(key: StoreKey<A>, value: A, current: () => boolean) =>
    Effect.gen(function* () {
      const json = yield* Schema.encodeEffect(Schema.fromJsonString(key.codec))(value).pipe(
        Effect.mapError((cause) => new StoreFailure({ key: key.name, cause })),
      );
      const now = yield* Clock.currentTimeMillis;
      yield* attempt(key.name, () => {
        if (!current()) return;
        const stored = db.prepare("SELECT value, revision FROM cache WHERE key = ?").get(key.name);
        if (stored?.value === json && stored.revision === revision) {
          db.prepare("UPDATE cache SET at = ? WHERE key = ?").run(now, key.name);
          return;
        }
        // Keep one predecessor of a versioned key as a fallback for when a source is down, and drop the rest.
        const prefix = key.name.match(VERSION)?.[1];
        if (prefix)
          db.prepare(
            "DELETE FROM cache WHERE key LIKE ? AND key <> ? AND key NOT IN (SELECT key FROM cache WHERE key LIKE ? AND key <> ? ORDER BY at DESC LIMIT 1)",
          ).run(`${prefix}%`, key.name, `${prefix}%`, key.name);
        db.prepare(
          "INSERT INTO cache (key, value, at, revision) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at, revision = excluded.revision",
        ).run(key.name, json, now, revision);
      });
    });

  const write = <A>(key: StoreKey<A>, value: A) => writeIf(key, value, () => true);

  /** The newest stored value of an earlier version of the key, for example resume:v9 when resume:v10 failed. */
  const previousVersion = <A>(key: StoreKey<A>) =>
    Effect.gen(function* () {
      const prefix = key.name.match(VERSION)?.[1];
      if (!prefix) return undefined;
      const older = yield* attempt(key.name, () => {
        const row = db
          .prepare("SELECT key FROM cache WHERE key LIKE ? AND key <> ? ORDER BY at DESC LIMIT 1")
          .get(`${prefix}%`, key.name);
        return typeof row?.key === "string" ? row.key : undefined;
      });
      return older ? yield* read({ name: older, codec: key.codec }) : undefined;
    });

  const running = new Map<string, { readonly generation: number; readonly fiber: Fiber.Fiber<unknown, unknown> }>();
  // Bumped when a key's stored value stops being current (forget, forced refresh). A fetch that started under an older
  // generation returns its result to its callers but does not store it.
  const generations = new Map<string, number>();
  const generation = (name: string) => generations.get(name) ?? 0;
  const bump = (name: string) => generations.set(name, generation(name) + 1);
  // Keys whose last refresh failed. They are not fetched again before `next` unless forced; the backoff doubles per
  // failure.
  const failing = new Map<string, { next: number; backoff: number; since: number }>();

  const failed = (name: string, cause: Cause.Cause<unknown>) =>
    Effect.gen(function* () {
      if (Cause.hasInterruptsOnly(cause)) return;
      const now = yield* Clock.currentTimeMillis;
      const before = failing.get(name);
      const backoff = before ? Math.min(before.backoff * 2, MAX_BACKOFF) : FIRST_BACKOFF;
      const asked = retryAfter(Cause.squash(cause));
      const wait = asked === undefined ? backoff : asked * 1000;
      failing.set(name, { next: now + wait, backoff, since: before ? before.since : now });
      if (!before)
        yield* Effect.logWarning(
          `Refresh failed for ${name}; next try in ${Duration.format(Duration.millis(wait))}`,
          cause,
        );
    });

  const recovered = (name: string) =>
    Effect.gen(function* () {
      const before = failing.get(name);
      if (!before) return;
      failing.delete(name);
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.logInfo(
        `${name} refreshed again after failing for ${Duration.format(Duration.millis(now - before.since))}`,
      );
    });

  /** When a failing key may be fetched again, or undefined when it may be fetched now. */
  const blockedUntil = (name: string) =>
    Effect.map(Clock.currentTimeMillis, (now) => {
      const next = failing.get(name)?.next;
      return next !== undefined && now < next ? next : undefined;
    });

  const refresh = <A, E, R>(
    key: StoreKey<A>,
    fetch: Effect.Effect<A, E, R>,
    options?: { readonly force?: boolean },
  ): Effect.Effect<A, E | StoreFailure, R> =>
    Effect.gen(function* () {
      const force = options?.force ?? (yield* ForceRefresh);
      if (force) bump(key.name);
      const blocked = force ? undefined : yield* blockedUntil(key.name);
      if (blocked !== undefined) {
        const stored = yield* read(key);
        if (stored) return stored.value;
        return yield* new StoreFailure({
          key: key.name,
          cause: new Error(`The last refresh failed; next try at ${new Date(blocked).toISOString()}`),
        });
      }
      const mine = generation(key.name);
      const shared = running.get(key.name);
      if (shared?.generation === mine) {
        // A second caller waits for the same fetch, then reads what it stored.
        yield* Fiber.join(shared.fiber).pipe(Effect.mapError((cause) => new StoreFailure({ key: key.name, cause })));
        const stored = yield* read(key);
        if (stored) return stored.value;
        // Forgotten while it ran, so its result was not stored.
        if (generation(key.name) !== mine) return yield* refresh(key, fetch);
        return yield* new StoreFailure({ key: key.name, cause: new Error("The refresh stored nothing") });
      }
      const fiber = yield* fetch.pipe(
        Effect.provideService(ForceRefresh, false),
        Effect.provideService(ReadOnly, false),
        Effect.tap((value) => writeIf(key, value, () => generation(key.name) === mine)),
        Effect.tap(() => recovered(key.name)),
        Effect.tapCause((cause) => (generation(key.name) === mine ? failed(key.name, cause) : Effect.void)),
        Effect.ensuring(
          Effect.sync(() => {
            if (running.get(key.name)?.generation === mine) running.delete(key.name);
          }),
        ),
        withIoSpan("Store.refresh", { attributes: { key: key.name } }),
        Effect.forkIn(scope),
      );
      running.set(key.name, { generation: mine, fiber });
      return yield* Fiber.join(fiber);
    });

  const cached = <A, E, R>(key: StoreKey<A>, fresh: Duration.Input, fetch: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const stored = yield* read(key);
      if (stored && (yield* ReadOnly)) return stored.value;
      const now = yield* Clock.currentTimeMillis;
      if (stored && now - stored.at.getTime() < Duration.toMillis(Duration.fromInputUnsafe(fresh))) return stored.value;
      const blocked = yield* blockedUntil(key.name);
      if (stored) {
        // A failure is logged by `failed` when the key starts failing, not on every refresh.
        if (blocked === undefined)
          yield* refresh(key, fetch, { force: false }).pipe(
            Effect.catchCause(() => Effect.void),
            Effect.forkIn(scope),
          );
        return stored.value;
      }
      return yield* refresh(key, fetch, { force: false }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const older = yield* previousVersion(key);
            if (!older) return yield* Effect.fail(error);
            yield* Effect.logWarning(
              `Could not build ${key.name}; showing the copy from ${older.at.toISOString()}`,
              error,
            );
            return older.value;
          }),
        ),
      );
    });

  return Store.of({
    read,
    write,
    storedAt: (name) =>
      attempt(name, () => {
        const row = db.prepare("SELECT at, revision FROM cache WHERE key = ?").get(name);
        return typeof row?.at === "number" && (!scopedKey(name) || row.revision === revision)
          ? new Date(row.at)
          : undefined;
      }),
    cached,
    refresh,
    retryPrefix: (prefix) =>
      Effect.sync(() => {
        for (const name of new Set([...failing.keys(), ...running.keys()])) {
          if (!name.startsWith(prefix)) continue;
          bump(name);
          failing.delete(name);
        }
      }),
    forget: (name) =>
      attempt(name, () => {
        bump(name);
        db.prepare("DELETE FROM cache WHERE key = ?").run(name);
      }),
    forgetPrefix: (prefix) =>
      attempt(`${prefix}*`, () => {
        for (const name of running.keys()) if (name.startsWith(prefix)) bump(name);
        db.prepare("DELETE FROM cache WHERE key LIKE ?").run(`${prefix}%`);
      }),
    prune: (prefix, age) =>
      Effect.gen(function* () {
        const before = (yield* Clock.currentTimeMillis) - Duration.toMillis(Duration.fromInputUnsafe(age));
        return yield* attempt(`${prefix}*`, () => {
          // substr, not LIKE: LIKE reads "_" in a key as a wildcard and ignores case.
          const result = db
            .prepare("DELETE FROM cache WHERE substr(key, 1, ?) = ? AND at <= ?")
            .run(prefix.length, prefix, before);
          return Number(result.changes);
        });
      }),
  });
}
