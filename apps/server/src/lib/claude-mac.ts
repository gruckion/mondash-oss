import { execFile } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Option, Schema } from "effect";
import { ActionError } from "./action-error";
import { claudeExecutable, listClaudeSessions, type ActiveClaude } from "./claude-remote";

export type MacSessionTarget = "terminal" | "claude-desktop" | undefined;
export type MacSessionDependencies = {
  live: (sessionId: string) => Promise<readonly ActiveClaude[]>;
  list: () => Promise<readonly ActiveClaude[]>;
  stop: (jobId: string) => Promise<void>;
  alive: (pid: number) => boolean;
  desktop: (sessionId: string) => Promise<void>;
  focus: (sessions: readonly ActiveClaude[], target: MacSessionTarget) => Promise<void>;
  terminal: (cwd: string, args: readonly string[], target: MacSessionTarget) => Promise<void>;
  sleep: () => Promise<void>;
  now: () => number;
};

/** Opens the original conversation in the selected Mac app. */
export function createMacSessionOpener(deps: MacSessionDependencies) {
  const pending = new Map<string, { target: MacSessionTarget; promise: Promise<void> }>();
  const isUuid = Schema.is(Schema.String.check(Schema.isUUID()));
  async function open(sessionId: string, cwd: string, target: MacSessionTarget) {
    // The process registry can focus an existing owner without starting the slow CLI listing.
    const registered = (await deps.live(sessionId)).filter(
      (entry) => entry.sessionId === sessionId && entry.kind !== "background" && entry.pid && deps.alive(entry.pid),
    );
    if (registered.length) return deps.focus(registered, target);
    const entries = (await deps.list()).filter((entry) => entry.sessionId === sessionId);
    const live = entries.filter((entry) => entry.kind !== "background" && entry.pid && deps.alive(entry.pid));
    if (live.length) return deps.focus(live, target);
    const session = entries.find((entry) => entry.kind === "background");
    if (session?.kind === "background") {
      const jobId = session.id;
      if (!jobId || !/^[a-f0-9]{8}$/.test(jobId) || !sessionId.startsWith(jobId))
        throw new ActionError("Could not identify this Claude background job. Check its status on your Mac.");
      if (target !== "claude-desktop") return deps.terminal(cwd, ["attach", jobId], target);

      // Revalidate the job immediately before asking Claude's supervisor to stop it.
      const current = (await deps.list()).find((entry) => entry.sessionId === sessionId);
      if (current && (current.kind !== "background" || current.id !== jobId || current.pid !== session.pid))
        throw new ActionError("This Claude session changed while opening it. Try again.");
      if (current) await deps.stop(jobId);
      const deadline = deps.now() + 15_000;
      while (true) {
        const latest = (await deps.list()).find((entry) => entry.sessionId === sessionId);
        if (latest?.pid && latest.pid !== session.pid && deps.alive(latest.pid))
          throw new ActionError("This Claude session restarted while opening it. Try again.");
        if ((!session.pid || !deps.alive(session.pid)) && (!latest?.pid || !deps.alive(latest.pid))) break;
        if (deps.now() >= deadline)
          throw new ActionError("Claude is still stopping safely. Wait a moment, then try opening it again.");
        await deps.sleep();
      }
    }
    if (target === "claude-desktop") return deps.desktop(sessionId);
    return deps.terminal(cwd, ["--resume", sessionId], target);
  }
  return (sessionId: string, cwd: string, target: MacSessionTarget): Promise<void> => {
    if (!isUuid(sessionId)) return Promise.reject(new ActionError("Invalid Claude session ID."));
    const running = pending.get(sessionId);
    if (running) {
      if (running.target !== target)
        return Promise.reject(
          new ActionError("This Claude session is already opening in another app. Wait, then retry."),
        );
      return running.promise;
    }
    const promise = open(sessionId, cwd, target).finally(() => pending.delete(sessionId));
    pending.set(sessionId, { target, promise });
    return promise;
  };
}

const run = promisify(execFile);
const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const decodeLiveRecord = Schema.decodeUnknownSync(
  Schema.Struct({
    pid: Schema.Int.check(Schema.isGreaterThan(0)),
    sessionId: Schema.String,
    entrypoint: Schema.String,
    hostSessionId: Schema.optional(Schema.String),
  }),
);

const registeredSession = Schema.decodeUnknownOption(
  Schema.Struct({
    pid: Schema.Int.check(Schema.isGreaterThan(0)),
    sessionId: Schema.String,
    kind: Schema.String,
    entrypoint: Schema.String,
  }),
);

/** Registry files are transient; a missing or partial record falls back to Claude's full listing. */
export async function registeredClaudeSessions(root: string, sessionId: string): Promise<readonly ActiveClaude[]> {
  const files = await readdir(root).catch((cause: unknown) => {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
    throw cause;
  });
  const records = await Promise.all(
    files
      .filter((file) => /^\d+\.json$/.test(file))
      .map(async (file) => {
        try {
          const record = registeredSession(JSON.parse(await readFile(join(root, file), "utf8")));
          if (Option.isNone(record)) return;
          const r = record.value;
          if (
            r.pid !== Number(file.slice(0, -5)) ||
            r.sessionId !== sessionId ||
            r.kind !== "interactive" ||
            (r.entrypoint !== "claude-desktop" && r.entrypoint !== "cli")
          )
            return;
          return { pid: r.pid, sessionId: r.sessionId, kind: r.kind };
        } catch (cause) {
          if (cause instanceof SyntaxError || (cause instanceof Error && "code" in cause && cause.code === "ENOENT"))
            return;
          throw cause;
        }
      }),
  );
  return records.filter((record): record is NonNullable<typeof record> => record !== undefined);
}

/** Choose a running owner, preferring the requested app if both Desktop and a terminal have it open. */
export function createLiveSessionFocuser(deps: {
  record: (pid: number) => Promise<unknown>;
  desktop: (hostSessionId: string) => Promise<void>;
  terminal: (pid: number) => Promise<void>;
}) {
  return async (sessions: readonly ActiveClaude[], target: MacSessionTarget) => {
    const owners = await Promise.all(
      sessions.map(async (session) => {
        if (!session.pid) throw new ActionError("The Claude session changed while opening it. Try again.");
        const record = decodeLiveRecord(await deps.record(session.pid));
        if (record.pid !== session.pid || record.sessionId !== session.sessionId)
          throw new ActionError("The Claude session changed while opening it. Try again.");
        return record;
      }),
    );
    const desktop = owners.find((record) => record.entrypoint === "claude-desktop");
    const terminal = owners.find((record) => record.entrypoint === "cli");
    const owner = target === "claude-desktop" ? (desktop ?? terminal) : (terminal ?? desktop);
    if (!owner) throw new ActionError("Could not locate the app running this Claude session. Try again.");
    if (owner.entrypoint === "cli") return deps.terminal(owner.pid);
    if (!owner.hostSessionId || !/^local_[A-Za-z0-9-]{1,64}$/.test(owner.hostSessionId))
      throw new ActionError("Could not identify this conversation in Claude Desktop. Try again.");
    return deps.desktop(owner.hostSessionId);
  };
}

/** Bring the app owning the running terminal process forward, without starting another shell or Claude. */
async function focusTerminalSession(pid: number) {
  const ancestors: number[] = [];
  let tty = "";
  for (let current = pid; current > 1 && ancestors.length < 16;) {
    if (ancestors.includes(current)) break;
    ancestors.push(current);
    const { stdout } = await run("/bin/ps", ["-p", String(current), "-o", "ppid=,tty="], { timeout: 3_000 });
    const match = stdout.trim().match(/^(\d+)\s+(\S+)$/);
    if (!match) break;
    if (current === pid) tty = match[2];
    current = Number(match[1]);
  }
  const { stdout } = await run(
    "/usr/bin/osascript",
    [
      "-l",
      "JavaScript",
      "-e",
      `ObjC.import('AppKit');
function run(argv) {
  const pids = argv[0].split(',').map(Number);
  const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  for (const pid of pids) {
    for (let i = 0; i < apps.count; i++) {
      const app = apps.objectAtIndex(i);
      if (Number(app.processIdentifier) !== pid) continue;
      const bundle = ObjC.unwrap(app.bundleIdentifier);
      if (!app.activateWithOptions(2)) throw new Error('Could not activate the terminal app');
      return bundle;
    }
  }
  throw new Error('The terminal app is no longer running');
}`,
      ancestors.join(","),
    ],
    { timeout: 8_000 },
  );
  if (stdout.trim() === "com.apple.Terminal" && /^ttys\d+$/.test(tty)) {
    await run(
      "/usr/bin/osascript",
      [
        "-e",
        `on run argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is item 1 of argv then
          set selected tab of w to t
          set index of w to 1
          activate
          return
        end if
      end repeat
    end repeat
  end tell
end run`,
        `/dev/${tty}`,
      ],
      { timeout: 8_000 },
    );
  }
}

/** One opener per server lifetime, so concurrent requests share the same handoff. */
export function claudeMacHost(claudeBin: Option.Option<string>, terminalApp: string) {
  const focus = createLiveSessionFocuser({
    record: async (pid) => JSON.parse(await readFile(join(homedir(), ".claude", "sessions", `${pid}.json`), "utf8")),
    desktop: async (hostSessionId) => {
      await run("open", ["-a", "Claude", `claude://code/continue?session=${encodeURIComponent(hostSessionId)}`], {
        timeout: 8_000,
      });
    },
    terminal: focusTerminalSession,
  });
  return createMacSessionOpener({
    live: (sessionId) => registeredClaudeSessions(join(homedir(), ".claude", "sessions"), sessionId),
    list: async () => {
      try {
        return await listClaudeSessions(claudeBin);
      } catch (cause) {
        throw new ActionError("Could not check Claude sessions on your Mac. Check Claude Code, then retry.", { cause });
      }
    },
    stop: async (jobId) => {
      try {
        await run(await claudeExecutable(claudeBin), ["stop", jobId], { timeout: 15_000 });
      } catch (cause) {
        throw new ActionError("Could not stop the background session safely. Check Claude Code, then retry.", {
          cause,
        });
      }
    },
    alive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (cause) {
        if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") return false;
        throw new ActionError("Could not confirm that the Claude session exited. Try again.", { cause });
      }
    },
    desktop: async (sessionId) => {
      try {
        await run("open", ["-a", "Claude", `claude://resume?session=${sessionId}`], { timeout: 8_000 });
      } catch (cause) {
        throw new ActionError("Could not open Claude Desktop. Install it and sign in, then try again.", { cause });
      }
    },
    focus: async (sessions, target) => {
      try {
        await focus(sessions, target);
      } catch (cause) {
        if (cause instanceof ActionError) throw cause;
        throw new ActionError("Could not bring the running Claude session forward. Try again.", { cause });
      }
    },
    terminal: async (cwd, args, target) => {
      const sessionId = args[1];
      const script = join(tmpdir(), `mondash-${sessionId}.command`);
      const command = [await claudeExecutable(claudeBin), ...args].map(shellQuote).join(" ");
      try {
        await writeFile(script, `#!/bin/zsh -l\ncd ${shellQuote(cwd)} && exec ${command}\n`, { mode: 0o755 });
        await run("open", ["-a", target === "terminal" ? "Terminal" : terminalApp, script], { timeout: 8_000 });
      } catch (cause) {
        throw new ActionError("Could not open the session in your Mac's terminal. Try again.", { cause });
      }
    },
    sleep: () => new Promise((resolve) => setTimeout(resolve, 150)),
    now: Date.now,
  });
}
