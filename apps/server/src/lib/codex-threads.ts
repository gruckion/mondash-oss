import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { Effect, Schema } from "effect";

const Thread = Schema.Struct({
  id: Schema.String,
  rollout_path: Schema.String,
  archived: Schema.Int,
  updated_at: Schema.Finite,
});
const decodeThreads = Schema.decodeUnknownSync(Schema.Array(Thread));

/** Codex's own archive flag, including resumed old threads that its date folders would miss. Never writes to its DB. */
export const readCodexThreads = (path: string) =>
  Effect.try(() => {
    if (!existsSync(path)) return [];
    const db = new Database(path, { readonly: true });
    try {
      return decodeThreads(db.query("SELECT id, rollout_path, archived, updated_at FROM threads").all());
    } finally {
      db.close();
    }
  }).pipe(
    Effect.catch((error) => Effect.logWarning("Could not read Codex archive metadata", error).pipe(Effect.as([]))),
  );
