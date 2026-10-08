import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { readCodexThreads } from "./codex-threads";

test("Codex archive changes are read from its database without writing to it", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "codex-archive-")), "state.sqlite");
  const db = new Database(path);
  db.run("CREATE TABLE threads (id TEXT, rollout_path TEXT, archived INTEGER, updated_at INTEGER)");
  db.run("INSERT INTO threads VALUES ('session', '/archive/session.jsonl', 1, 1791000000)");
  const archived = await Effect.runPromise(readCodexThreads(path));
  assert.equal(archived[0].archived, 1);
  db.run("UPDATE threads SET archived = 0");
  assert.equal((await Effect.runPromise(readCodexThreads(path)))[0].archived, 0);
  assert.equal(db.query<{ n: number }, []>("SELECT count(*) AS n FROM threads").get()?.n, 1);
  db.close();
});
