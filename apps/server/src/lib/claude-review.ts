import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { Option, Schema, SchemaTransformation } from "effect";
import { ActionError } from "./action-error";
import type { ClaudeHost } from "./claude-remote.ts";

const run = promisify(execFile);
const prUrl = Schema.String.check(
  Schema.isPattern(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/),
);
const scopeFields = {
  urls: Schema.mutable(Schema.Array(prUrl)).check(Schema.isMinLength(1), Schema.isMaxLength(30)),
  /** Related PRs that are not ready for human review: named in the prompt so the review leaves them alone. */
  notReady: Schema.optional(Schema.mutable(Schema.Array(prUrl)).check(Schema.isMaxLength(30))),
  cwd: Schema.String.check(Schema.makeFilter(isAbsolute)),
  title: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(5000)).pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transform({ decode: (value) => value.slice(0, 200), encode: (value) => value }),
    ),
  ),
};
const scopeSchema = Schema.Struct(scopeFields);
const decodeScope = Schema.decodeUnknownOption(scopeSchema);
export type ClaudeReviewScope = typeof scopeSchema.Type;
const recordSchema = Schema.Struct({
  ...scopeFields,
  launchId: Schema.String.check(Schema.isUUID()),
  sessionId: Schema.optional(Schema.String.check(Schema.isUUID())),
  createdAt: Schema.String.check(Schema.makeFilter((s) => !Number.isNaN(Date.parse(s)))),
  state: Schema.Literals(["starting", "ready", "failed"]),
  url: Schema.optional(Schema.String),
});
const decodeRecord = Schema.decodeUnknownSync(recordSchema);
export type ClaudeReviewLaunch = typeof recordSchema.Type;
const decodeAgents = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      sessionId: Schema.String.check(Schema.isUUID()),
      name: Schema.optional(Schema.String),
      cwd: Schema.optional(Schema.String),
      kind: Schema.String,
    }),
  ),
);
/** A review that is running, and its Remote Control link. A failure throws an ActionError instead. */
export type ClaudeReview = { url: string; sessionId: string; reused: boolean };

export function claudeReviewPrompt(urls: ReadonlyArray<string>, notReady: ReadonlyArray<string> = []) {
  const one = urls.length === 1;
  const waiting = notReady.length
    ? [
        `These related pull requests are not ready for review yet. Do not review them; mention one only if a finding depends on it:\n${notReady.join("\n")}`,
      ]
    : [];
  return [
    `Code review\n${urls.join("\n")}`,
    one ? "Review this pull request." : "Review these pull requests together as one change.",
    ...waiting,
    "Check the affected code and tests for correctness, regressions and missing coverage. Support findings with evidence and file links.",
    "Return the review in this conversation, with the conclusion first and actionable findings ordered by importance.",
    "This request is for analysis. Changes and external actions require a separate request.",
  ].join("\n\n");
}

/** The scope as a launch records it: checked, with its PRs unique and sorted. */
function normalizeScope(input: ClaudeReviewScope): ClaudeReviewScope {
  const parsed = decodeScope(input);
  if (Option.isNone(parsed)) throw new ActionError("This review has invalid pull request or project details.");
  return { ...parsed.value, urls: [...new Set(parsed.value.urls)].sort() };
}

/** The newest recorded review that shares a PR with `scope`: a start reopens it unless `startNew`. */
const latestOverlapping = (records: ReadonlyArray<ClaudeReviewLaunch>, scope: ClaudeReviewScope) =>
  records
    .filter((record) => record.urls.some((url) => scope.urls.includes(url)))
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

const partialReview = (record: ClaudeReviewLaunch, scope: ClaudeReviewScope) =>
  scope.urls.some((url) => !record.urls.includes(url))
    ? new ActionError(
        "An existing review covers only some of these pull requests. Open that session and add the newly related PR URLs so Claude can review them together.",
        { review: { sessionId: record.sessionId } },
      )
    : undefined;

/** The first message of a new review session. A reopened review is sent none. */
const reviewKickoff = (record: Pick<ClaudeReviewLaunch, "urls" | "notReady">) =>
  claudeReviewPrompt(record.urls, record.notReady);

/** What a start of this review would do: the PRs it covers, and the prompt it sends unless it reopens a review. */
export type ClaudeReviewPreview = { urls: string[]; notReady: string[]; prompt: string; reopens: boolean };

/** Reads `records` the way a launch claims one; throws an ActionError where the launch would. */
export function previewClaudeReview(
  records: ReadonlyArray<ClaudeReviewLaunch>,
  input: ClaudeReviewScope,
  startNew = false,
): ClaudeReviewPreview {
  const scope = normalizeScope(input);
  const existing = startNew ? undefined : latestOverlapping(records, scope);
  if (!existing)
    return { urls: scope.urls, notReady: scope.notReady ?? [], prompt: reviewKickoff(scope), reopens: false };
  const partial = partialReview(existing, scope);
  if (partial) throw partial;
  return {
    urls: existing.urls,
    notReady: existing.notReady ?? [],
    prompt: reviewKickoff(existing),
    reopens: existing.state !== "failed",
  };
}

/** Separate from disposable response caches: a launch reservation must survive refreshes and restarts. */
export function createClaudeReviewRegistry(file: string) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000");
  db.exec("CREATE TABLE IF NOT EXISTS launches (session_id TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const list = (): ClaudeReviewLaunch[] =>
    db
      .prepare("SELECT value FROM launches")
      .all()
      .map((row) => decodeRecord(JSON.parse(String(row.value))));
  const save = (record: ClaudeReviewLaunch) => {
    db.prepare(
      "INSERT INTO launches(session_id, value) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET value = excluded.value",
    ).run(record.launchId, JSON.stringify(record));
  };
  return {
    list,
    save,
    close: () => db.close(),
    /** `startNew` reserves a new review even when one already covers these PRs ("New review" in the sessions sheet). */
    claim(scope: ClaudeReviewScope, startNew = false): { record: ClaudeReviewLaunch; fresh: boolean } {
      // Synchronous transaction also serializes different server processes, not just taps in this one.
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = startNew ? undefined : latestOverlapping(list(), scope);
        let record: ClaudeReviewLaunch = existing ?? {
          ...scope,
          title: `PR risk review: ${scope.title}`.slice(0, 200),
          launchId: randomUUID(),
          createdAt: new Date().toISOString(),
          state: "starting",
        };
        const fresh = !existing || existing.state === "failed";
        if (fresh) {
          record = { ...record, state: "starting" };
          save(record);
        }
        db.exec("COMMIT");
        return { record, fresh };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

export type ClaudeReviewDependencies = {
  claim: (scope: ClaudeReviewScope, startNew: boolean) => Promise<{ record: ClaudeReviewLaunch; fresh: boolean }>;
  save: (record: ClaudeReviewLaunch) => Promise<void>;
  start: (record: ClaudeReviewLaunch, prompt: string) => Promise<void>;
  find: (record: ClaudeReviewLaunch) => Promise<string | undefined>;
  url: (sessionId: string) => Promise<string | undefined>;
  /** The Remote Control link of a session that connected before; throws an ActionError when it cannot. */
  resume: (sessionId: string) => Promise<string>;
  now: () => number;
  sleep: () => Promise<void>;
};

export function createClaudeReviewLauncher(deps: ClaudeReviewDependencies) {
  const pending = new Map<string, Promise<ClaudeReview>>();
  async function connect(
    record: ClaudeReviewLaunch,
    fresh: boolean,
    prompt: string | undefined,
  ): Promise<ClaudeReview> {
    try {
      if (fresh) {
        try {
          await deps.start(record, prompt ?? reviewKickoff(record));
        } catch (error) {
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            ["ENOENT", "EACCES"].includes(String(error.code))
          ) {
            await deps.save({ ...record, state: "failed" });
            throw new ActionError(
              "Claude could not start. Check that Claude Code and this project directory are available on your Mac, then retry.",
              { cause: error },
            );
          }
          // A timed-out launcher may still have succeeded. Locate its unique marker below.
        }
      }
      // Only previously connected sessions are resumed. An uncertain first launch is never repeated.
      if (!fresh && record.state === "ready" && record.sessionId) {
        const sessionId = record.sessionId;
        const url = await deps.resume(sessionId).catch((error: unknown) => {
          throw error instanceof ActionError
            ? new ActionError(error.message, { review: { sessionId }, cause: error })
            : error;
        });
        await deps.save({ ...record, url });
        return { url, sessionId, reused: true };
      }
      const deadline = deps.now() + 30_000;
      do {
        if (!record.sessionId) {
          const sessionId = await deps.find(record);
          if (sessionId) {
            record = { ...record, sessionId };
            await deps.save(record);
          }
        }
        const url = record.sessionId ? await deps.url(record.sessionId) : undefined;
        if (url && record.sessionId) {
          await deps.save({ ...record, state: "ready", url });
          return { url, sessionId: record.sessionId, reused: !fresh };
        }
        await deps.sleep();
      } while (deps.now() < deadline);
      throw new ActionError(
        "Your review is starting, but Claude has not connected Remote Control yet. Retry to reconnect to this same session.",
        { review: { sessionId: record.sessionId, pending: true } },
      );
    } catch (error) {
      if (error instanceof ActionError) throw error;
      // Even a launcher timeout may have spawned successfully. Keep its reservation and ID.
      throw new ActionError(
        "Claude could not finish connecting this review. Retry to check the same session; if it still cannot connect, check Claude’s login and workspace trust on your Mac.",
        { review: { sessionId: record.sessionId, pending: true }, cause: error },
      );
    }
  }
  /** `prompt` replaces the usual first message of a new review; a reopened review is sent none. */
  return async (input: ClaudeReviewScope, startNew = false, prompt?: string): Promise<ClaudeReview> => {
    const scope = normalizeScope(input);
    let claimed: { record: ClaudeReviewLaunch; fresh: boolean };
    try {
      claimed = await deps.claim(scope, startNew);
    } catch (error) {
      throw new ActionError("Could not safely reserve a Claude review on your Mac. Try again.", { cause: error });
    }
    const { record, fresh } = claimed;
    const partial = partialReview(record, scope);
    if (partial) throw partial;
    const existing = pending.get(record.launchId);
    if (existing) return existing;
    const request = connect(record, fresh, prompt).finally(() => pending.delete(record.launchId));
    pending.set(record.launchId, request);
    return request;
  };
}

export function claudeReviewName(record: ClaudeReviewLaunch) {
  return `${record.title} [Mondash ${record.launchId}]`;
}

export function claudeReviewArguments(record: ClaudeReviewLaunch, prompt: string) {
  return [
    "--bg",
    "--remote-control",
    claudeReviewName(record),
    "--name",
    claudeReviewName(record),
    "--permission-mode",
    "auto",
    "--",
    prompt,
  ];
}

export function findClaudeReviewSession(record: ClaudeReviewLaunch, records: unknown): string | undefined {
  const entries = decodeAgents(records);
  const matches = entries.filter(
    (entry) => entry.name === claudeReviewName(record) && entry.cwd === record.cwd && entry.kind === "background",
  );
  // Never choose between multiple candidates or guess a UUID from a short prefix.
  return matches.length === 1 ? matches[0].sessionId : undefined;
}

/** Starts reviews with the Claude CLI and records them in `registry`. The Claude service makes one for the server. */
export function claudeReviewLauncher(claude: ClaudeHost, registry: ReturnType<typeof createClaudeReviewRegistry>) {
  return createClaudeReviewLauncher({
    claim: async (input, startNew) => registry.claim(input, startNew),
    save: async (record) => registry.save(record),
    start: async (record, prompt) => {
      await run(await claude.executable(), claudeReviewArguments(record, prompt), {
        cwd: record.cwd,
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, PATH: [join(homedir(), ".local/bin"), process.env.PATH].filter(Boolean).join(":") },
      });
    },
    find: async (record) => {
      const { stdout } = await run(await claude.executable(), ["agents", "--json", "--all"], {
        timeout: 8_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      return findClaudeReviewSession(record, JSON.parse(stdout));
    },
    url: claude.urlForSession,
    resume: claude.open,
    now: Date.now,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 750)),
  });
}
