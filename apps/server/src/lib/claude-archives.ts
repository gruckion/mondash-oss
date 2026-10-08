import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Effect, Option, Schema } from "effect";
import type { AgentSession } from "./sessions";
import { addRefs } from "./refs";

const CLAUDE_SESSIONS_ROOT = join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions");
const Uuid = Schema.String.check(Schema.isUUID());
const NativeRecord = Schema.Struct({
  sessionId: Schema.String.check(Schema.isPattern(/^local_[a-f0-9-]{36}$/)),
  cliSessionId: Schema.optional(Uuid),
  priorCliSessionIds: Schema.optional(Schema.Array(Uuid)),
  isArchived: Schema.Boolean,
  lastActivityAt: Schema.optional(Schema.Finite),
});
const decode = Schema.decodeUnknownOption(NativeRecord);
const directories = async (path: string) => {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(path, entry.name));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
};

/** Claude Desktop owns these flags. Missing records mean unknown, never an inferred archive. */
export const readClaudeSessions = (root = CLAUDE_SESSIONS_ROOT) =>
  Effect.tryPromise(async () => {
    const accounts = await directories(root);
    const organisations = (await Promise.all(accounts.map(directories))).flat();
    const files: string[] = [];
    for (const directory of organisations) {
      const entries = await readdir(directory, { withFileTypes: true });
      files.push(
        ...entries
          .filter((entry) => entry.isFile() && /^local_[a-f0-9-]{36}\.json$/.test(entry.name))
          .map((entry) => join(directory, entry.name)),
      );
    }
    const records: Array<typeof NativeRecord.Type> = [];
    // Desktop records include snapshots; bound open files even when a history has thousands of sessions.
    for (let offset = 0; offset < files.length; offset += 8) {
      const batch = await Promise.all(
        files.slice(offset, offset + 8).map(async (file) => {
          try {
            const record = decode(JSON.parse(await readFile(file, "utf8")));
            return Option.isSome(record) && file.endsWith(`/${record.value.sessionId}.json`) ? record.value : undefined;
          } catch {
            return undefined;
          }
        }),
      );
      records.push(...batch.filter((record) => record !== undefined));
    }
    records.sort((a, b) => (a.lastActivityAt ?? 0) - (b.lastActivityAt ?? 0));
    const result = new Map<string, { conversationId: string; archived: boolean }>();
    for (const record of records) {
      const metadata = { conversationId: record.sessionId.slice(6), archived: record.isArchived };
      for (const id of record.priorCliSessionIds ?? []) result.set(id, metadata);
      result.set(metadata.conversationId, metadata);
    }
    // An exact current CLI id takes priority over a historical alias.
    for (const record of records)
      if (record.cliSessionId)
        result.set(record.cliSessionId, {
          conversationId: record.sessionId.slice(6),
          archived: record.isArchived,
        });
    return result;
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not read Claude session metadata", error).pipe(
        Effect.as(new Map<string, { conversationId: string; archived: boolean }>()),
      ),
    ),
  );

/** Keep each native conversation once, with an openable transcript ID, its latest activity and all earlier evidence. */
export const mergeClaudeContinuations = Effect.fnUntraced(function* (
  sessions: ReadonlyArray<AgentSession>,
  root = CLAUDE_SESSIONS_ROOT,
) {
  const metadata = yield* readClaudeSessions(root);
  const conversations = new Map<string, AgentSession>();
  for (const session of [...sessions].sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())) {
    const native = session.tool === "claude" ? metadata.get(session.id) : undefined;
    const current = native ? { ...session, ...native } : session;
    const key = `${session.tool}:${current.conversationId ?? current.id}`;
    const previous = conversations.get(key);
    conversations.set(
      key,
      previous
        ? {
            ...current,
            firstPrompt: previous.firstPrompt || current.firstPrompt,
            contextSummary: current.contextSummary ?? previous.contextSummary,
            branch: current.branch ?? previous.branch,
            refs: addRefs(previous.refs, current.refs),
            promptRefs: addRefs(previous.promptRefs, current.promptRefs),
            linkedPRs: [...new Set([...(previous.linkedPRs ?? []), ...(current.linkedPRs ?? [])])],
          }
        : current,
    );
  }
  return [...conversations.values()].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
});

/** All transcript aliases of a nominated native conversation, including older context outside the activity window. */
export const expandClaudeFiles = Effect.fnUntraced(function* (
  files: ReadonlyArray<string>,
  available: ReadonlyArray<string>,
  root = CLAUDE_SESSIONS_ROOT,
) {
  const metadata = yield* readClaudeSessions(root);
  const identity = (file: string) => metadata.get(basename(file, ".jsonl"))?.conversationId;
  const nominated = new Set(files.map(identity).filter((id) => id !== undefined));
  return [
    ...new Set([
      ...files,
      ...available.filter((file) => {
        const id = identity(file);
        return id !== undefined && nominated.has(id);
      }),
    ]),
  ];
});
