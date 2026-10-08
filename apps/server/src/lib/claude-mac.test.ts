import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createLiveSessionFocuser,
  createMacSessionOpener,
  registeredClaudeSessions,
  type MacSessionDependencies,
} from "./claude-mac";
import type { ActiveClaude } from "./claude-remote";

const id = "9190d58e-8dfe-525c-8fad-e93466b03f81";
const background: ActiveClaude = { sessionId: id, id: "9190d58e", pid: 100, kind: "background" };
const cwd = "/test/project";

function harness(entries: readonly ActiveClaude[] = [background], overrides: Partial<MacSessionDependencies> = {}) {
  const calls: string[] = [];
  let listed = entries;
  let alive = entries.some((entry) => entry.pid === 100);
  let time = 0;
  const deps: MacSessionDependencies = {
    live: async () => [],
    list: async () => listed,
    stop: async (jobId) => {
      calls.push(`stop ${jobId}`);
    },
    alive: () => alive,
    desktop: async (sessionId) => {
      // Claude Desktop refuses to resume a transcript that the background process owns.
      if (alive) throw new Error(`Session ${sessionId} is running as a background session`);
      calls.push(`desktop ${sessionId}`);
    },
    focus: async (sessions, target) => {
      assert.ok(sessions.every((session) => session.sessionId === id));
      calls.push(`focus ${sessions.map((session) => session.pid).join(",")} ${target ?? "legacy"}`);
    },
    terminal: async (_cwd, args, target) => {
      assert.equal(_cwd, cwd);
      calls.push(`${target ?? "legacy"} ${args.join(" ")}`);
    },
    sleep: async () => {
      time += 1000;
      alive = false;
      listed = entries.map((entry) => ({ ...entry, pid: undefined }));
    },
    now: () => time,
    ...overrides,
  };
  return { calls, deps, open: createMacSessionOpener(deps) };
}

test("Desktop stops the selected background job and waits for exit before resuming the original conversation", async () => {
  const h = harness();
  await h.open(id, cwd, "claude-desktop");
  assert.deepEqual(h.calls, [`stop ${background.id}`, `desktop ${id}`]);
});

test("Terminal attaches to a running background job without stopping or resuming a second process", async () => {
  const h = harness();
  await h.open(id, cwd, "terminal");
  assert.deepEqual(h.calls, [`terminal attach ${background.id}`]);
});

test("saved background jobs attach in the configured terminal even when their process has stopped", async () => {
  const h = harness([{ ...background, pid: undefined }]);
  await h.open(id, cwd, undefined);
  assert.deepEqual(h.calls, [`legacy attach ${background.id}`]);
});

test("ordinary stopped conversations resume in either app without stopping unrelated jobs", async () => {
  const unrelated = { ...background, sessionId: "FF72D97B-08D1-5D66-B204-0574B0A0BAC6", id: "ff72d97b", pid: 200 };
  const h = harness([unrelated]);
  await h.open(id, cwd, "terminal");
  await h.open(id, cwd, "claude-desktop");
  assert.deepEqual(h.calls, [`terminal --resume ${id}`, `desktop ${id}`]);
});

test("Desktop waits for the original PID to exit even if it disappears from the CLI listing", async () => {
  let alive = true;
  let listed: readonly ActiveClaude[] = [background];
  const h = harness([], {
    list: async () => listed,
    alive: () => alive,
    stop: async () => {
      listed = [];
    },
    sleep: async () => {
      assert.deepEqual(h.calls, []);
      alive = false;
    },
  });
  await h.open(id, cwd, "claude-desktop");
  assert.deepEqual(h.calls, [`desktop ${id}`]);
});

test("a stop timeout never launches Desktop, and a later retry succeeds once the original exits", async () => {
  let alive = true;
  let time = 0;
  const h = harness([], {
    list: async () => [background],
    alive: () => alive,
    sleep: async () => {
      time += 5000;
    },
    now: () => time,
  });
  await assert.rejects(h.open(id, cwd, "claude-desktop"), /still stopping safely/);
  assert.deepEqual(h.calls, [`stop ${background.id}`]);
  alive = false;
  await h.open(id, cwd, "claude-desktop");
  assert.deepEqual(h.calls, [`stop ${background.id}`, `stop ${background.id}`, `desktop ${id}`]);
});

test("stop and listing failures never launch Desktop", async () => {
  for (const failure of ["list", "stop"] as const) {
    const h = harness([background], {
      [failure]: async () => {
        throw new Error(`${failure} failed`);
      },
    });
    await assert.rejects(h.open(id, cwd, "claude-desktop"), new RegExp(`${failure} failed`));
    assert.deepEqual(h.calls, []);
  }
});

test("changed job identity is refused before stopping anything", async () => {
  for (const replacement of [
    { ...background, pid: 200 },
    { ...background, id: "ff72d97b" },
    { ...background, kind: "interactive" },
  ]) {
    let lists = 0;
    const h = harness([background], { list: async () => [++lists === 1 ? background : replacement] });
    await assert.rejects(h.open(id, cwd, "claude-desktop"), /changed while opening/);
    assert.deepEqual(h.calls, []);
  }
});

test("a replacement process after stop prevents the Desktop launch", async () => {
  let stopped = false;
  const h = harness([background], {
    list: async () => [{ ...background, pid: stopped ? 200 : 100 }],
    stop: async () => {
      stopped = true;
    },
    alive: () => true,
  });
  await assert.rejects(h.open(id, cwd, "claude-desktop"), /restarted while opening/);
  assert.deepEqual(h.calls, []);
});

test("concurrent taps share one stop and launch; switching targets during the handoff is refused", async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = harness();
  const stop = h.deps.stop;
  h.deps.stop = async (jobId) => {
    await stop(jobId);
    await wait;
  };
  const first = h.open(id, cwd, "claude-desktop");
  const second = h.open(id, cwd, "claude-desktop");
  assert.equal(first, second);
  await assert.rejects(h.open(id, cwd, "terminal"), /already opening in another app/);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(h.calls, [`stop ${background.id}`, `desktop ${id}`]);
});

test("live interactive sessions focus their current app without stopping or resuming them", async () => {
  const h = harness([{ ...background, kind: "interactive" }]);
  await h.open(id, cwd, "claude-desktop");
  await h.open(id, cwd, "terminal");
  assert.deepEqual(h.calls, ["focus 100 claude-desktop", "focus 100 terminal"]);
});

test("a registered live conversation focuses even when the CLI session check would time out", async () => {
  const h = harness([], {
    live: async () => [{ ...background, kind: "interactive" }],
    alive: () => true,
    list: async () => {
      throw new Error("Claude agents timed out");
    },
  });
  await h.open(id, cwd, "claude-desktop");
  assert.deepEqual(h.calls, ["focus 100 claude-desktop"]);
});

test("dead registry entries still require the full CLI check before resuming", async () => {
  const h = harness([], {
    live: async () => [{ ...background, kind: "interactive" }],
    alive: () => false,
    list: async () => {
      throw new Error("Claude agents timed out");
    },
  });
  await assert.rejects(h.open(id, cwd, "claude-desktop"), /Claude agents timed out/);
  assert.deepEqual(h.calls, []);
});

test("registry lookup selects matching interactive owners and tolerates transient files", async () => {
  const root = await mkdtemp(join(tmpdir(), "mondash-claude-registry-"));
  try {
    const record = { pid: 100, sessionId: id, kind: "interactive", entrypoint: "claude-desktop" };
    await Promise.all([
      writeFile(join(root, "100.json"), JSON.stringify(record)),
      writeFile(join(root, "200.json"), JSON.stringify({ ...record, pid: 200, entrypoint: "cli" })),
      writeFile(join(root, "300.json"), JSON.stringify({ ...record, pid: 300, kind: "background" })),
      writeFile(join(root, "400.json"), JSON.stringify({ ...record, pid: 500 })),
      writeFile(join(root, "600.json"), JSON.stringify({ ...record, pid: 600, sessionId: "other" })),
      writeFile(join(root, "700.json"), "{incomplete"),
      writeFile(join(root, "800.json"), JSON.stringify({ ...record, pid: "800" })),
      writeFile(join(root, "notes.json"), JSON.stringify(record)),
    ]);
    assert.deepEqual(
      [...(await registeredClaudeSessions(root, id))].sort((a, b) => (a.pid ?? 0) - (b.pid ?? 0)),
      [
        { pid: 100, sessionId: id, kind: "interactive" },
        { pid: 200, sessionId: id, kind: "interactive" },
      ],
    );
    assert.deepEqual(await registeredClaudeSessions(join(root, "missing"), id), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("all live owners of the same conversation are passed to focus; stopped and unrelated entries are ignored", async () => {
  const interactive = { ...background, kind: "interactive" };
  const h = harness(
    [
      interactive,
      { ...interactive, pid: 200 },
      { ...interactive, pid: 300 },
      { ...interactive, sessionId: "other", pid: 400 },
    ],
    { alive: (pid) => pid !== 300 },
  );
  await h.open(id, cwd, "claude-desktop");
  assert.deepEqual(h.calls, ["focus 100,200 claude-desktop"]);
});

test("Desktop focus uses its existing host conversation, while a terminal-only conversation focuses its process", async () => {
  const calls: string[] = [];
  const focus = createLiveSessionFocuser({
    record: async (pid) => ({
      pid,
      sessionId: id,
      entrypoint: pid === 100 ? "cli" : "claude-desktop",
      hostSessionId: `local_${id}`,
    }),
    desktop: async (hostSessionId) => {
      calls.push(`desktop ${hostSessionId}`);
    },
    terminal: async (pid) => {
      calls.push(`terminal ${pid}`);
    },
  });
  const terminal = { ...background, kind: "interactive" };
  const desktop = { ...terminal, pid: 200 };
  await focus([terminal, desktop], "claude-desktop");
  await focus([terminal, desktop], "terminal");
  await focus([desktop], "terminal");
  await focus([terminal], "claude-desktop");
  assert.deepEqual(calls, [`desktop local_${id}`, "terminal 100", `desktop local_${id}`, "terminal 100"]);
});

test("focus revalidates the registry identity and rejects invalid Desktop conversation IDs", async () => {
  let launches = 0;
  for (const record of [
    { pid: 200, sessionId: id, entrypoint: "cli" },
    { pid: 100, sessionId: "another-session", entrypoint: "cli" },
    { pid: 100, sessionId: id, entrypoint: "claude-desktop", hostSessionId: "local_;command" },
    { pid: 100, sessionId: id, entrypoint: "claude-desktop" },
  ]) {
    const focus = createLiveSessionFocuser({
      record: async () => record,
      desktop: async () => {
        launches += 1;
      },
      terminal: async () => {
        launches += 1;
      },
    });
    await assert.rejects(focus([{ ...background, kind: "interactive" }], "claude-desktop"));
  }
  assert.equal(launches, 0);
});

test("invalid UUIDs and unrecognized background IDs never stop or launch a session", async () => {
  const h = harness();
  await assert.rejects(h.open("not-a-session", cwd, "claude-desktop"), /Invalid Claude session ID/);
  for (const jobId of [undefined, "ff72d97b", "9190d58e; command"]) {
    h.deps.list = async () => [{ ...background, id: jobId }];
    await assert.rejects(h.open(id, cwd, "claude-desktop"), /Could not identify/);
  }
  assert.deepEqual(h.calls, []);
});
