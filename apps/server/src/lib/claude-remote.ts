import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { ActionError } from "./action-error";
import { Option, Schema } from "effect";
import { ClaudeSignedOut, claudeExecutable, ensureClaudeAuthenticated } from "./claude-cli";
export { claudeExecutable } from "./claude-cli";

const isUuid = Schema.is(Schema.String.check(Schema.isUUID()));
const run = promisify(execFile);
const activeSchema = Schema.Array(
  Schema.Struct({
    sessionId: Schema.String,
    pid: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
    id: Schema.optional(Schema.String),
    name: Schema.optional(Schema.String),
    kind: Schema.String,
  }),
);
const decodeActive = Schema.decodeUnknownSync(activeSchema);
export type ActiveClaude = (typeof activeSchema.Type)[number];
const bridgeRecord = Schema.decodeUnknownOption(
  Schema.Struct({ pid: Schema.Finite, sessionId: Schema.String, bridgeSessionId: Schema.String }),
);
const processRecord = Schema.decodeUnknownSync(
  Schema.Struct({ pid: Schema.Finite, sessionId: Schema.String, kind: Schema.String, entrypoint: Schema.String }),
);

/** Only a live process registry entry counts; historical transcript links may be offline. */
export function remoteUrl(record: unknown, session: ActiveClaude): string | undefined {
  const parsed = bridgeRecord(record);
  if (Option.isNone(parsed) || parsed.value.pid !== session.pid || parsed.value.sessionId !== session.sessionId) return;
  const id = parsed.value.bridgeSessionId;
  if (!/^(session|cse)_[A-Za-z0-9_-]{1,128}$/.test(id)) return;
  return `https://claude.ai/code/${id.replace(/^cse_/, "session_")}`;
}

export type NewSessionDependencies = {
  ensureAuthenticated: () => Promise<void>;
  /** Runs `claude --bg` for a session, with `prompt` as its first message if given, and returns what it printed. */
  start: (cwd: string, name: string, prompt: string | undefined) => Promise<string>;
  list: () => Promise<ReadonlyArray<ActiveClaude>>;
  url: (session: ActiveClaude) => Promise<string | undefined>;
  sleep: () => Promise<void>;
  now: () => number;
};

const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * Starts a Remote Control session and waits until claude.ai has its URL. A running session with the same name is
 * opened instead, so a second tap does not start a second copy.
 */
export function createNewSessionStarter(deps: NewSessionDependencies) {
  return async (cwd: string, name: string, prompt?: string): Promise<string> => {
    const running = (await deps.list()).find((entry) => entry.name === name && entry.pid);
    const reused = running ? await deps.url(running) : undefined;
    if (reused) return reused;
    await deps.ensureAuthenticated();
    const printed = (await deps.start(cwd, name, prompt)).replace(ANSI, "");
    const id = printed.match(/backgrounded\s*·\s*([a-f0-9]{8})/)?.[1];
    if (!id) throw new ActionError("Claude did not start a session on your Mac. Check that Claude Code is signed in.");
    const deadline = deps.now() + 30_000;
    while (deps.now() < deadline) {
      const session = (await deps.list()).find((entry) => entry.sessionId.startsWith(id));
      const url = session ? await deps.url(session) : undefined;
      if (url) return url;
      await deps.sleep();
    }
    await deps.ensureAuthenticated();
    throw new ActionError(
      "The session started on your Mac, but Remote Control has not connected yet. Open it from the Sessions tab shortly.",
    );
  };
}

/**
 * Your usual start on a Linear ticket, as one message: read it, then plan the change without making it. With PRs already
 * open or merged for it, the plan covers only what they leave.
 */
export function ticketKickoffPrompt(url: string, prs: ReadonlyArray<string> = []) {
  return [
    `Read this ${url} and its comments. Do not action it yet.`,
    prs.length
      ? `Work on it has already started:\n${prs.join("\n")}\nRead those PRs and the affected repositories to identify completed work and remaining tasks. Present the plan here and do not make any changes yet.`
      : "Read the affected repositories and identify the changes needed. Present the plan here and do not make any changes yet.",
  ].join("\n\n");
}

/** A session on a PR with no known ticket, as one message: read it, then work out what it still needs. */
export function prKickoffPrompt(url: string) {
  return [
    `Read this ${url}, its description and its review comments. Do not action it yet.`,
    "Read the affected code and tests, identify completed work and remaining tasks, and present the findings here. Do not make any changes yet.",
  ].join("\n\n");
}

/** A kickoff session: a Linear ticket to plan, or a PR with no known ticket to catch up on. */
export type Kickoff =
  { kind: "ticket"; ticketId: string; url: string; prs: ReadonlyArray<string> } | { kind: "pr"; url: string };

/** "web#1856" for https://github.com/ExampleOrg/web/pull/1856. */
const prName = (url: string) => url.replace(/^https:\/\/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)$/, "$1#$2");

/** A kickoff's session name, which makes a second tap open the running session, and its usual first message. */
export function kickoff(request: Kickoff): { name: string; prompt: string } {
  return request.kind === "ticket"
    ? {
        name: `${request.ticketId} ${request.prs.length ? "catch up" : "plan"}`,
        prompt: ticketKickoffPrompt(request.url, request.prs),
      }
    : { name: `${prName(request.url)} catch up`, prompt: prKickoffPrompt(request.url) };
}

/** The CLI arguments of a new session. The prompt is one argument after `--`, so it is never read as an option. */
export function newSessionArguments(name: string, prompt: string | undefined) {
  return [
    "--bg",
    "--remote-control",
    name,
    "--name",
    name,
    "--permission-mode",
    "auto",
    ...(prompt === undefined ? [] : ["--", prompt]),
  ];
}

export type RemoteDependencies = {
  ensureAuthenticated: () => Promise<void>;
  find: (id: string) => Promise<{ cwd: string } | undefined>;
  list: () => Promise<readonly ActiveClaude[]>;
  url: (session: ActiveClaude) => Promise<string | undefined>;
  start: (id: string, cwd: string, savedBackground: boolean) => Promise<void>;
  prepareRemote: (session: ActiveClaude, cwd: string) => Promise<void>;
  sleep: () => Promise<void>;
  now: () => number;
};

export function createRemoteOpener(deps: RemoteDependencies) {
  const pending = new Map<string, Promise<string>>();
  const started = new Set<string>();
  const ensureAuthenticated = async (id: string) => {
    try {
      await deps.ensureAuthenticated();
    } catch (error) {
      // After reauthentication, a worker started while signed out needs preparation again.
      if (error instanceof ClaudeSignedOut) started.delete(id);
      throw error;
    }
  };
  /** The session's Remote Control link; a failure throws an ActionError that says what to do. */
  async function prepare(id: string): Promise<string> {
    const session = await deps.find(id);
    if (!session) throw new ActionError("This Claude session is no longer available on your Mac.");
    // --all lists saved jobs before live owners, including two records for the same conversation.
    const matches = (await deps.list()).filter((entry) => entry.sessionId === id);
    const known = matches.find((entry) => entry.pid) ?? matches[0];
    const active = known?.pid ? known : undefined;
    for (const owner of matches.filter((entry) => entry.pid)) {
      const url = await deps.url(owner);
      if (url) {
        started.delete(id);
        return url;
      }
    }
    await ensureAuthenticated(id);
    if (active) {
      if (!started.has(id)) {
        await deps.prepareRemote(active, session.cwd);
        started.add(id);
      }
    } else if (!started.has(id)) {
      await deps.start(id, session.cwd, known?.kind === "background");
      started.add(id);
    }
    const deadline = deps.now() + 30_000;
    do {
      await deps.sleep();
      for (const owner of (await deps.list()).filter((entry) => entry.sessionId === id && entry.pid)) {
        const url = await deps.url(owner);
        if (url) {
          started.delete(id);
          return url;
        }
      }
    } while (deps.now() < deadline);
    await ensureAuthenticated(id);
    throw new ActionError("Claude has not connected this session to your phone yet. Please retry.");
  }
  return (id: string): Promise<string> => {
    if (!isUuid(id)) return Promise.reject(new ActionError("Invalid Claude session ID."));
    const existing = pending.get(id);
    if (existing) return existing;
    const request = prepare(id).finally(() => pending.delete(id));
    pending.set(id, request);
    return request;
  };
}

export type PreparationDependencies = {
  list: () => Promise<readonly ActiveClaude[]>;
  record: (pid: number) => Promise<unknown>;
  url: (session: ActiveClaude) => Promise<string | undefined>;
};

/** Joining from a phone must never stop, restart, or fork the process doing the work. */
export function createRemotePreparer(deps: PreparationDependencies) {
  return async (session: ActiveClaude) => {
    const background = session.kind === "background";
    if (!session.pid || (session.kind !== "interactive" && !background))
      throw new ActionError("Claude could not prepare this session for your phone. Try again.");
    const current = (await deps.list()).find(
      (entry) => entry.sessionId === session.sessionId && entry.pid === session.pid,
    );
    if (!current)
      throw new ActionError("Could not connect to Claude: the session changed while opening it. Try again.");
    const record = processRecord(await deps.record(session.pid));
    if (
      record.pid !== session.pid ||
      record.sessionId !== session.sessionId ||
      record.kind !== (background ? "bg" : "interactive") ||
      (record.entrypoint !== "cli" && (background || record.entrypoint !== "claude-desktop"))
    )
      throw new ActionError("Could not connect to Claude: the running process does not match this session.");
    if (await deps.url(current)) return;
    // The SDK's remote_control request goes through Desktop's private stdin transport. The public CLI's
    // peer socket does not handle enable_remote_control in 2.1.289/2.1.293; a successful write is not a connection.
    if (record.entrypoint === "claude-desktop")
      throw new ActionError(
        "Your Mac session is kept running. Turn on Remote Control from this conversation's menu in Claude Desktop, then retry. For future sessions, enable Settings → Claude Code → Connect new sessions to Remote Control.",
      );
    throw new ActionError(
      background
        ? `Your Mac session is kept running. On your Mac, run claude attach ${session.sessionId.slice(0, 8)}, then /remote-control in that conversation and retry.`
        : "Your Mac session is kept running. Run /remote-control in that Claude conversation on your Mac, then retry. You can use both devices once it connects.",
    );
  };
}

/** Why `claude --bg --resume` failed, in words for the person. */
export function resumeFailure(error: unknown): ActionError {
  if (error instanceof ActionError) return error;
  const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
  if (/not trusted/i.test(stderr))
    return new ActionError("Open this project in Claude on your Mac and accept its workspace trust prompt first.", {
      cause: error,
    });
  return new ActionError(
    "Could not resume Claude on your Mac. Check that Claude Code is signed in and supports Remote Control.",
    { cause: error },
  );
}

const claudeRoot = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

/** Fail closed if the installed CLI changes its contract; never assume no active sessions. */
export async function listClaudeSessions(claudeBin: Option.Option<string>) {
  const { stdout } = await run(await claudeExecutable(claudeBin), ["agents", "--json", "--all"], {
    // Listing from the launch agent can exceed 8 seconds; keep a bounded wait without treating failure as empty.
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return decodeActive(JSON.parse(stdout));
}

/**
 * The Claude Code CLI on this Mac: `claudeBin` overrides where it is. The Claude service (services/claude.ts) makes one
 * host for the server's lifetime, so concurrent requests for one session share a launch.
 */
export function claudeHost(claudeBin: Option.Option<string>) {
  const executable = () => claudeExecutable(claudeBin);

  const ensureAuthenticated = async () => ensureClaudeAuthenticated(await executable());

  /** Resolve only an existing local transcript, never a directory supplied by the phone. */
  async function findSession(id: string) {
    const root = join(claudeRoot, "projects");
    for (const project of await readdir(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const file = join(root, project.name, `${id}.jsonl`);
      if (
        !(await access(file).then(
          () => true,
          () => false,
        ))
      )
        continue;
      let cwd: string | undefined;
      let permissionMode: string | undefined;
      const input = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
      for await (const line of input) {
        try {
          const row = JSON.parse(line);
          if (row.sessionId !== id) continue;
          if (typeof row.cwd === "string") cwd = row.cwd;
          if (row.type === "user" && typeof row.permissionMode === "string") permissionMode = row.permissionMode;
        } catch {
          /* A running session may have an incomplete final line. */
        }
      }
      if (cwd && (await stat(cwd).catch(() => undefined))?.isDirectory()) return { cwd, permissionMode };
    }
  }

  const listActive = () => listClaudeSessions(claudeBin);
  async function liveUrl(session: ActiveClaude) {
    if (!session.pid) return;
    try {
      process.kill(session.pid, 0);
      return remoteUrl(
        JSON.parse(await readFile(join(claudeRoot, "sessions", `${session.pid}.json`), "utf8")),
        session,
      );
    } catch {
      return undefined;
    }
  }

  /** Poll the live bridge registry directly; spawning `agents --all` on every poll can take seconds. */
  async function urlForSession(id: string) {
    if (!isUuid(id)) return;
    const root = join(claudeRoot, "sessions");
    const files = await readdir(root).catch(() => []);
    for (const file of files.filter((name) => /^\d+\.json$/.test(name))) {
      try {
        const record = processRecord(JSON.parse(await readFile(join(root, file), "utf8")));
        if (
          record.pid !== Number(file.slice(0, -5)) ||
          record.sessionId !== id ||
          (record.kind !== "bg" && record.kind !== "interactive") ||
          (record.entrypoint !== "cli" && record.entrypoint !== "claude-desktop")
        )
          continue;
        const url = await liveUrl({ sessionId: id, pid: record.pid, kind: record.kind });
        if (url) return url;
      } catch {
        // A process may exit or be midway through writing its registry record.
      }
    }
  }

  const prepareRemote = createRemotePreparer({
    list: listActive,
    record: async (pid) => JSON.parse(await readFile(join(claudeRoot, "sessions", `${pid}.json`), "utf8")),
    url: liveUrl,
  });
  async function resumeArguments(id: string, savedBackground: boolean) {
    // Saved jobs reject added flags by forking. Preserve their original launch options.
    if (savedBackground) {
      const saved = Schema.decodeUnknownSync(
        Schema.Struct({ sessionId: Schema.String, respawnFlags: Schema.Array(Schema.String) }),
      )(JSON.parse(await readFile(join(claudeRoot, "jobs", id.slice(0, 8), "state.json"), "utf8")));
      if (saved.sessionId !== id)
        throw new ActionError("Could not resume Claude: the saved job belongs to another conversation.");
      if (!saved.respawnFlags.some((flag) => /^--(remote-control|rc)(=|$)/.test(flag)))
        throw new ActionError(
          "This saved Claude job has Remote Control disabled. Enable Remote Control in that conversation before retrying.",
        );
      return ["--bg", "--resume", id];
    }
    // --resume does not restore permission mode. Carry the latest mode recorded by the conversation.
    const session = await findSession(id);
    const mode = session?.permissionMode ?? "default";
    if (!["default", "auto", "acceptEdits", "plan", "dontAsk", "bypassPermissions"].includes(mode))
      throw new ActionError("Could not resume Claude: its saved permission mode is not supported by Mondash.");
    return ["--bg", "--resume", id, "--remote-control", "--permission-mode", mode];
  }
  async function startSession(id: string, cwd: string, savedBackground: boolean) {
    try {
      const args = await resumeArguments(id, savedBackground);
      const { stdout } = await run(await executable(), args, {
        cwd,
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, PATH: [join(homedir(), ".local/bin"), process.env.PATH].filter(Boolean).join(":") },
      });
      // The CLI forks when a concurrent terminal resumes the same conversation. Do not hand off that copy.
      const printed = stdout.replace(ANSI, "");
      const background = printed.match(/backgrounded\s*·\s*([a-f0-9]{8})/);
      if (!background || background[1] !== id.slice(0, 8)) {
        if (background) await run(await executable(), ["stop", background[1]], { timeout: 8_000 });
        throw new ActionError(
          background
            ? "Claude started a copy instead of reconnecting. Mondash stopped that copy; retry to connect to the original conversation."
            : "Claude did not confirm that the original conversation resumed. Please retry.",
          {
            cause: new Error(
              `Claude resume identity mismatch: requested ${id}; launcher output: ${printed.slice(0, 8_000)}`,
            ),
          },
        );
      }
    } catch (error) {
      throw resumeFailure(error);
    }
  }

  return {
    open: createRemoteOpener({
      ensureAuthenticated,
      find: findSession,
      list: listActive,
      url: liveUrl,
      start: startSession,
      prepareRemote,
      sleep: () => new Promise((resolve) => setTimeout(resolve, 750)),
      now: Date.now,
    }),
    /** A session in `cwd`, in auto permission mode, reachable over Remote Control; `prompt` is its first message. */
    startNew: createNewSessionStarter({
      ensureAuthenticated,
      start: async (cwd, name, prompt) => {
        const { stdout } = await run(await executable(), newSessionArguments(name, prompt), {
          cwd,
          timeout: 20_000,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, PATH: [join(homedir(), ".local/bin"), process.env.PATH].filter(Boolean).join(":") },
        });
        return stdout;
      },
      list: listActive,
      url: liveUrl,
      sleep: () => new Promise((resolve) => setTimeout(resolve, 750)),
      now: Date.now,
    }),
    /** Shared process identity checks for new review sessions and existing-session handoff. */
    executable,
    list: listActive,
    url: liveUrl,
    urlForSession,
  };
}

export type ClaudeHost = ReturnType<typeof claudeHost>;
