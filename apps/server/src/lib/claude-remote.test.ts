import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Option } from "effect";
import { ActionError } from "./action-error";
import { ClaudeSignedOut } from "./claude-cli";
import { settle } from "./settle.ts";
import { ClaudeFailure } from "@/services/claude";
import { toActionFailure } from "@/services/errors";
import {
  createRemoteOpener,
  createRemotePreparer,
  claudeHost,
  remoteUrl,
  resumeFailure,
  type ActiveClaude,
  type RemoteDependencies,
  type PreparationDependencies,
  createNewSessionStarter,
  newSessionArguments,
  prKickoffPrompt,
  ticketKickoffPrompt,
} from "./claude-remote.ts";

const id = "FF72D97B-08D1-5D66-B204-0574B0A0BAC6";
const otherId = "F828D7E6-F804-57F2-AEC7-131E5D46DE3D";
const cwd = "/test/project";
const active: ActiveClaude = { sessionId: id, pid: 100, kind: "interactive" };
const expectedUrl = "https://claude.ai/code/session_Example123";

function harness(overrides: Partial<RemoteDependencies> = {}) {
  const calls: {
    find: string[];
    list: number;
    url: ActiveClaude[];
    start: [string, string, boolean][];
    prepareRemote: [ActiveClaude, string][];
    sleep: number;
  } = { find: [], list: 0, url: [], start: [], prepareRemote: [], sleep: 0 };
  let time = 0;
  const deps: RemoteDependencies = {
    ensureAuthenticated: async () => {},
    find: async (value) => {
      calls.find.push(value);
      return { cwd };
    },
    list: async () => {
      calls.list++;
      return [];
    },
    url: async (value) => {
      calls.url.push(value);
      return undefined;
    },
    start: async (value, directory, background) => {
      calls.start.push([value, directory, background]);
    },
    prepareRemote: async (value, directory) => {
      calls.prepareRemote.push([value, directory]);
    },
    sleep: async () => {
      calls.sleep++;
      time += 10_000;
    },
    now: () => time,
    ...overrides,
  };
  const opener = createRemoteOpener(deps);
  return { calls, deps, opener, open: (value: string) => settle(opener(value).then((url) => ({ url }))) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

test("remote URL only uses a matching live registry record and normalizes cse IDs", () => {
  assert.equal(remoteUrl({ pid: 100, sessionId: id, bridgeSessionId: "session_Example123" }, active), expectedUrl);
  assert.equal(remoteUrl({ pid: 100, sessionId: id, bridgeSessionId: "cse_Example123" }, active), expectedUrl);
  assert.equal(
    remoteUrl({ pid: 100, sessionId: id, bridgeSessionId: "cse_Example-123_abc" }, active),
    "https://claude.ai/code/session_Example-123_abc",
  );
  for (const record of [
    { pid: 101, sessionId: id, bridgeSessionId: "session_Example123" },
    { pid: 100, sessionId: otherId, bridgeSessionId: "session_Example123" },
    { pid: 100, sessionId: id },
    { pid: "100", sessionId: id, bridgeSessionId: "session_Example123" },
    null,
  ])
    assert.equal(remoteUrl(record, active), undefined);
  for (const bridgeSessionId of [
    "https://evil.test",
    "session_../escape",
    "session_a?redirect=evil",
    "session_a#evil",
    "session_a/evil",
    "session_a%2fevil",
    "session_",
    "SESSION_abc",
    "cse_a\n",
  ]) {
    assert.equal(remoteUrl({ pid: 100, sessionId: id, bridgeSessionId }, active), undefined, bridgeSessionId);
  }
});

test("review connection finds only its live bridge without launching the CLI or needing a transcript", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mondash-review-bridge-"));
  const registry = join(directory, "sessions");
  await mkdir(registry);
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { Option } from "effect";
import { claudeHost } from ${JSON.stringify(join(import.meta.dirname, "claude-remote.ts"))};
const host = claudeHost(Option.some("/missing/claude"));
const file = ${JSON.stringify(registry)} + "/" + process.pid + ".json";
const record = { pid: process.pid, sessionId: ${JSON.stringify(id)}, kind: "bg", entrypoint: "cli", bridgeSessionId: "session_Example123" };
for (const value of ["{", JSON.stringify({ ...record, sessionId: ${JSON.stringify(otherId)} }), JSON.stringify({ ...record, pid: process.pid + 1 }), JSON.stringify({ ...record, bridgeSessionId: "https://evil.test" })]) {
  await writeFile(file, value);
  assert.equal(await host.urlForSession(${JSON.stringify(id)}), undefined);
}
await writeFile(file, JSON.stringify(record));
assert.equal(await host.urlForSession(${JSON.stringify(id)}), ${JSON.stringify(expectedUrl)});
assert.equal(await host.urlForSession("../private"), undefined);
console.log("connected");
`,
      ],
      { env: { ...process.env, CLAUDE_CONFIG_DIR: directory }, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim(), "connected");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("already-live Remote Control reuses its URL without launch or polling", async () => {
  const saved: ActiveClaude = { sessionId: id, kind: "background", id: id.slice(0, 8) };
  const disconnected = { ...active, pid: 101 };
  const h = harness({
    list: async () => [saved, disconnected, active],
    url: async (session) => (session.pid === active.pid ? expectedUrl : undefined),
    ensureAuthenticated: async () => {
      throw new Error("A connected session does not need an authentication check");
    },
  });
  assert.deepEqual(await h.open(id), { ok: true, url: expectedUrl });
  assert.deepEqual(h.calls.find, [id]);
  assert.deepEqual(h.calls.start, []);
  assert.equal(h.calls.sleep, 0);
  assert.deepEqual(h.calls.prepareRemote, []);
});

test("a disconnected session reports lost login without launching or stopping it, and can retry after login", async () => {
  for (const listed of [[], [active], [{ ...active, kind: "background" }]]) {
    let loggedIn = false;
    const h = harness({
      list: async () => listed,
      ensureAuthenticated: async () => {
        if (!loggedIn) throw new ActionError("Claude Code is no longer logged in on your Mac.");
      },
    });
    const result = await h.open(id);
    assert.deepEqual(result, { ok: false, message: "Claude Code is no longer logged in on your Mac." });
    assert.deepEqual(h.calls.start, []);
    assert.deepEqual(h.calls.prepareRemote, []);
    assert.equal(h.calls.sleep, 0);
    loggedIn = true;
    let connected = false;
    h.deps.url = async () => (connected ? expectedUrl : undefined);
    h.deps.sleep = async () => {
      connected = true;
    };
    h.deps.list = async () => (connected ? [active] : listed);
    assert.deepEqual(await h.open(id), { ok: true, url: expectedUrl });
  }
});

test("Claude's CLI authentication result reaches the app, including signed-out exit status 1", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mondash-claude-auth-"));
  try {
    const executable = join(directory, "claude");
    for (const { stdout, exitCode, message } of [
      {
        stdout: '{"loggedIn":false,"authMethod":"none"}',
        exitCode: 1,
        message: "Claude Code is no longer logged in on your Mac.",
      },
      { stdout: '{"loggedIn":false}', exitCode: 0, message: "Claude Code is no longer logged in on your Mac." },
      {
        stdout: "CLI unavailable",
        exitCode: 1,
        message: "Could not check whether Claude Code is logged in on your Mac. Try again.",
      },
    ]) {
      await writeFile(
        executable,
        `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args[0] === "agents") console.log("[]");\nelse if (args[0] === "auth" && args[1] === "status") { console.log(${JSON.stringify(stdout)}); process.exit(${exitCode}); }\nelse { console.log("Unexpected session launch"); process.exit(1); }\n`,
        { mode: 0o700 },
      );
      const host = claudeHost(Option.some(executable));
      const cause = await host.startNew(directory, "Mondash").then(
        () => assert.fail("Must not start without a verified login"),
        (error: unknown) => error,
      );
      const failure = toActionFailure("newClaudeSession", "fallback")(new ClaudeFailure({ cause }));
      assert.equal(failure.message, message);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("active session without Remote Control is prepared once, then opened after exact-session polling", async () => {
  let connected = false;
  const saved: ActiveClaude = { sessionId: id, kind: "background", id: id.slice(0, 8) };
  const h = harness({ list: async () => [saved, active], url: async () => (connected ? expectedUrl : undefined) });
  h.deps.sleep = async () => {
    h.calls.sleep++;
    connected = true;
  };
  assert.deepEqual(await h.open(id), { ok: true, url: expectedUrl });
  assert.deepEqual(h.calls.prepareRemote, [[active, cwd]]);
  assert.deepEqual(h.calls.start, []);
  assert.equal(h.calls.sleep, 1);
});

test("stopped session launches the exact original ID and cwd, then polls only that ID", async () => {
  let listings = 0;
  const checked: string[] = [];
  const unrelated: ActiveClaude = { sessionId: otherId, pid: 200, kind: "interactive" };
  const h = harness({
    list: async () => (++listings < 3 ? [unrelated] : [unrelated, active]),
    url: async (value) => {
      checked.push(value.sessionId);
      return expectedUrl;
    },
  });
  assert.deepEqual(await h.open(id), { ok: true, url: expectedUrl });
  assert.deepEqual(h.calls.start, [[id, cwd, false]]);
  assert.equal(h.calls.sleep, 2);
  assert.deepEqual(checked, [id]);
});

test("simultaneous requests for one session share a single launch and result", async () => {
  const firstList = deferred<ActiveClaude[]>();
  let listings = 0;
  const h = harness({
    list: async () => (++listings === 1 ? firstList.promise : [active]),
    url: async () => expectedUrl,
  });
  const first = h.opener(id);
  const second = h.opener(id);
  assert.equal(first, second);
  firstList.resolve([]);
  assert.deepEqual(await Promise.all([first, second]), [expectedUrl, expectedUrl]);
  assert.deepEqual(h.calls.find, [id]);
  assert.deepEqual(h.calls.start, [[id, cwd, false]]);
});

test("timeout retry waits for the session it started instead of rejecting or launching another", async () => {
  let launched = false;
  let connected = false;
  const starts: [string, string, boolean][] = [];
  const h = harness({
    list: async () => (launched ? [active] : []),
    start: async (value, directory, background) => {
      starts.push([value, directory, background]);
      launched = true;
    },
    url: async () => (connected ? expectedUrl : undefined),
  });
  const timedOut = await h.open(id);
  assert.equal(timedOut.ok, false);
  if (!timedOut.ok) assert.match(timedOut.message, /not connected[\s\S]*retry/);
  assert.equal(h.calls.sleep, 3);
  // This retry must enter polling (rather than report an externally active session without Remote Control).
  h.deps.sleep = async () => {
    connected = true;
  };
  assert.deepEqual(await h.open(id), { ok: true, url: expectedUrl });
  assert.deepEqual(starts, [[id, cwd, false]]);
});

test("a timeout with a delayed registry does not launch a duplicate on retry", async () => {
  let listed = false;
  const h = harness({ list: async () => (listed ? [active] : []), url: async () => expectedUrl });
  assert.equal((await h.open(id)).ok, false);
  assert.equal(h.calls.start.length, 1);
  h.deps.sleep = async () => {
    listed = true;
  };
  assert.deepEqual(await h.open(id), { ok: true, url: expectedUrl });
  assert.deepEqual(h.calls.start, [[id, cwd, false]]);
});

test("login lost during startup reports signed out and reprepares the same background session after sign-in", async () => {
  let launched = false;
  let loggedIn = true;
  let connected = false;
  const background = { ...active, kind: "background", id: id.slice(0, 8) };
  const h = harness({
    ensureAuthenticated: async () => {
      if (!loggedIn) throw new ClaudeSignedOut();
    },
    list: async () => (launched ? [background] : []),
    start: async () => {
      launched = true;
    },
    url: async () => (connected ? expectedUrl : undefined),
  });
  const sleep = h.deps.sleep;
  h.deps.sleep = async () => {
    loggedIn = false;
    await sleep();
  };
  assert.deepEqual(await h.open(id), { ok: false, message: "Claude Code is no longer logged in on your Mac." });
  loggedIn = true;
  h.deps.sleep = sleep;
  h.deps.prepareRemote = async (session) => {
    assert.equal(session.sessionId, id);
    connected = true;
  };
  assert.deepEqual(await h.open(id), { ok: true, url: expectedUrl });
});

test("invalid session IDs perform no lookup, process listing, launch or polling", async () => {
  const h = harness();
  for (const invalid of ["", "../private", `${id}; command`, "ff72d97b-1111-1111-1111-ff72d97b1111", "not-a-session"]) {
    assert.deepEqual(await h.open(invalid), { ok: false, message: "Invalid Claude session ID." });
  }
  assert.deepEqual(h.calls, { find: [], list: 0, url: [], start: [], prepareRemote: [], sleep: 0 });
});

test("missing transcript never lists or launches sessions", async () => {
  const h = harness({ find: async () => undefined });
  const result = await h.open(id);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /no longer available/);
  assert.equal(h.calls.list, 0);
  assert.deepEqual(h.calls.start, []);
});

test("failed process listing fails closed and clears pending state for a safe retry", async () => {
  let fail = true;
  const h = harness({
    list: async () => {
      if (fail) throw new Error("CLI unavailable");
      return [active];
    },
    url: async () => expectedUrl,
  });
  await assert.rejects(h.open(id), /CLI unavailable/);
  assert.deepEqual(h.calls.start, []);
  fail = false;
  assert.deepEqual(await h.open(id), { ok: true, url: expectedUrl });
  assert.deepEqual(h.calls.find, [id, id]);
  assert.deepEqual(h.calls.start, []);
});

test("stopped saved background sessions use the background resume path without treating them as live", async () => {
  const saved: ActiveClaude = { sessionId: id, kind: "background", id: "background-id" };
  let listings = 0;
  const h = harness({ list: async () => (++listings === 1 ? [saved] : [active]), url: async () => expectedUrl });
  assert.deepEqual(await h.open(id), { ok: true, url: expectedUrl });
  assert.deepEqual(h.calls.start, [[id, cwd, true]]);
  assert.equal(h.calls.sleep, 1);
});

test("successful handoff clears launch tracking so an ended session can later be resumed", async () => {
  let listed = false;
  const starts: [string, string, boolean][] = [];
  const h = harness({
    list: async () => (listed ? [active] : []),
    url: async () => expectedUrl,
    start: async (value, directory, background) => {
      starts.push([value, directory, background]);
      listed = true;
    },
  });
  assert.deepEqual(await h.open(id), { ok: true, url: expectedUrl });
  listed = false;
  assert.deepEqual(await h.open(id), { ok: true, url: expectedUrl });
  assert.deepEqual(starts, [
    [id, cwd, false],
    [id, cwd, false],
  ]);
});

test("failed Remote Control preparation never starts another session or returns a handoff", async () => {
  const h = harness({ list: async () => [active] });
  h.deps.prepareRemote = async (value, directory) => {
    h.calls.prepareRemote.push([value, directory]);
    throw new Error("Original process did not exit safely");
  };
  await assert.rejects(h.open(id), /did not exit safely/);
  assert.deepEqual(h.calls.prepareRemote, [[active, cwd]]);
  assert.deepEqual(h.calls.start, []);
  assert.equal(h.calls.sleep, 0);
  assert.deepEqual(h.calls.url, [active], "only the pre-preparation live URL lookup occurs");
});

test("simultaneous requests share one Remote Control preparation", async () => {
  const ready = deferred<void>();
  let connected = false;
  const h = harness({ list: async () => [active], url: async () => (connected ? expectedUrl : undefined) });
  h.deps.prepareRemote = async (value, directory) => {
    h.calls.prepareRemote.push([value, directory]);
    await ready.promise;
    connected = true;
  };
  const first = h.opener(id);
  const second = h.opener(id);
  assert.equal(first, second);
  ready.resolve();
  assert.deepEqual(await Promise.all([first, second]), [expectedUrl, expectedUrl]);
  assert.deepEqual(h.calls.prepareRemote, [[active, cwd]]);
  assert.deepEqual(h.calls.start, []);
});

test("retry after failed preparation reattempts preparation instead of assuming it started", async () => {
  let attempts = 0;
  let connected = false;
  const h = harness({ list: async () => [active], url: async () => (connected ? expectedUrl : undefined) });
  h.deps.prepareRemote = async () => {
    attempts++;
    if (attempts === 1) throw new Error("Registry identity changed");
    connected = true;
  };
  await assert.rejects(h.open(id), /Registry identity changed/);
  assert.deepEqual(await h.open(id), { ok: true, url: expectedUrl });
  assert.equal(attempts, 2);
  assert.deepEqual(h.calls.start, []);
});

const causes = (error: unknown): unknown[] =>
  error instanceof Error && error.cause !== undefined ? [error.cause, ...causes(error.cause)] : [];

test("phone opens preserve every active owner and retry its own connection", async () => {
  for (const [entrypoint, kind] of [
    ["cli", "interactive"],
    ["cli", "background"],
    ["claude-desktop", "interactive"],
  ]) {
    const session = { ...active, kind, id: id.slice(0, 8) };
    let connected = false;
    const h = harness({
      list: async () => [session],
      url: async () => (connected ? expectedUrl : undefined),
    });
    h.deps.prepareRemote = createRemotePreparer({
      list: h.deps.list,
      url: h.deps.url,
      record: async () => ({
        pid: active.pid,
        sessionId: id,
        kind: kind === "background" ? "bg" : "interactive",
        entrypoint,
      }),
    });
    const result = await h.open(id);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /kept running/);
    assert.deepEqual(h.calls.start, [], "Opening from a phone cannot replace the Mac process");
    connected = true;
    assert.equal(await h.opener(id), expectedUrl);
    assert.deepEqual(h.calls.start, []);
  }
});

test("preparing an active connection rejects changed owners and accepts a bridge that just connected", async () => {
  const deps: PreparationDependencies = {
    list: async () => [active],
    record: async () => ({ pid: active.pid, sessionId: id, kind: "interactive", entrypoint: "claude-desktop" }),
    url: async () => expectedUrl,
  };
  for (const change of [
    { list: async () => [{ ...active, pid: 999 }] },
    {
      record: async () => ({ pid: active.pid, sessionId: otherId, kind: "interactive", entrypoint: "claude-desktop" }),
    },
    { record: async () => ({ pid: active.pid, sessionId: id, kind: "interactive", entrypoint: "unknown" }) },
  ])
    await assert.rejects(createRemotePreparer({ ...deps, ...change })(active), ActionError);
  await createRemotePreparer(deps)(active);
});

test("resuming an ordinary conversation carries its latest recorded permission mode into Claude", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mondash-claude-resume-"));
  const project = join(directory, ".claude", "projects", "-resume-test");
  const registry = join(directory, ".claude", "sessions");
  await mkdir(project, { recursive: true });
  await mkdir(registry, { recursive: true });
  const executable = join(directory, "claude");
  const receipt = join(directory, "launched.json");
  try {
    for (const mode of ["auto", "acceptEdits", "plan"]) {
      const sessionId = randomUUID();
      await rm(receipt, { force: true });
      await writeFile(
        join(project, `${sessionId}.jsonl`),
        [
          { type: "user", sessionId, cwd: directory, permissionMode: "default" },
          { type: "user", sessionId, cwd: directory, permissionMode: mode },
        ]
          .map((row) => JSON.stringify(row))
          .join("\n"),
      );
      await writeFile(
        executable,
        `#!${process.execPath}
import { existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "agents") console.log(JSON.stringify(existsSync(${JSON.stringify(receipt)}) ? [{ sessionId: ${JSON.stringify(sessionId)}, pid: Number(process.env.RESUME_TEST_PID), kind: "background" }] : []));
else if (args[0] === "auth") console.log('{"loggedIn":true}');
else if (args[0] === "--bg") { writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(args)); console.log("backgrounded · ${sessionId.slice(0, 8)}"); }
else process.exit(1);
`,
        { mode: 0o700 },
      );
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `
import { writeFile } from "node:fs/promises";
import { Option } from "effect";
import { claudeHost } from ${JSON.stringify(join(import.meta.dirname, "claude-remote.ts"))};
process.env.RESUME_TEST_PID = String(process.pid);
await writeFile(${JSON.stringify(registry)} + "/" + process.pid + ".json", JSON.stringify({ pid: process.pid, sessionId: ${JSON.stringify(sessionId)}, bridgeSessionId: "session_Example123" }));
console.log(await claudeHost(Option.some(${JSON.stringify(executable)})).open(${JSON.stringify(sessionId)}));
`,
        ],
        { env: { ...process.env, CLAUDE_CONFIG_DIR: join(directory, ".claude") }, stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      assert.equal(code, 0, stderr);
      assert.equal(stdout.trim(), expectedUrl);
      const args: string[] = JSON.parse(await readFile(receipt, "utf8"));
      assert.equal(args[args.indexOf("--permission-mode") + 1], mode);
      assert.equal(args[args.indexOf("--resume") + 1], sessionId);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a workspace trust failure reaches the app in the person's words, and the log keeps the CLI error", () => {
  const cli = Object.assign(new Error("Command failed: claude --bg"), { stderr: "Error: workspace not trusted" });
  const failure = toActionFailure("openClaudeSession", "fallback")(new ClaudeFailure({ cause: resumeFailure(cli) }));
  assert.equal(failure.message, "Open this project in Claude on your Mac and accept its workspace trust prompt first.");
  assert.ok(causes(failure).includes(cli));
  assert.equal(
    toActionFailure("openClaudeSession", "fallback")(resumeFailure(new Error("spawn failed"))).message,
    "Could not resume Claude on your Mac. Check that Claude Code is signed in and supports Remote Control.",
  );
});

test("a new session is found by the id Claude prints, colour codes and all, and opens once Remote Control connects", async () => {
  const sessionId = "109b9d51-3250-5208-a7a4-d813ea27cfc4";
  const session = { pid: 14743, sessionId, cwd: "/work", kind: "background" };
  let connected = false;
  let starts = 0;
  const startNew = createNewSessionStarter({
    ensureAuthenticated: async () => {},
    start: async () => {
      starts++;
      return "backgrounded · \u001b[36m109b9d51\u001b[39m · Mondash 25 Sep 21:40\n";
    },
    list: async () => [session],
    url: async () => (connected ? "https://claude.ai/code/session_SyntheticExample123" : undefined),
    sleep: async () => {
      connected = true;
    },
    now: () => 0,
  });
  assert.equal(await startNew("/work", "Mondash"), "https://claude.ai/code/session_SyntheticExample123");
  assert.equal(starts, 1);
});

test("a new session that Claude did not start says so", async () => {
  const startNew = createNewSessionStarter({
    ensureAuthenticated: async () => {},
    start: async () => "Not logged in",
    list: async () => [],
    url: async () => undefined,
    sleep: async () => {},
    now: () => 0,
  });
  await assert.rejects(startNew("/work", "Mondash"), /did not start a session/);
});

test("a running session with the same name is opened instead of starting a second one", async () => {
  let starts = 0;
  const running = {
    pid: 7,
    sessionId: "098f088e-e8f4-5647-b871-85df016d6cc0",
    name: "DEMO-4224 plan",
    kind: "background",
  };
  const startNew = createNewSessionStarter({
    ensureAuthenticated: async () => {},
    start: async () => {
      starts++;
      return "";
    },
    list: async () => [running],
    url: async () => "https://claude.ai/code/session_Existing1",
    sleep: async () => {},
    now: () => 0,
  });
  assert.equal(await startNew("/work", "DEMO-4224 plan", "read it"), "https://claude.ai/code/session_Existing1");
  assert.equal(starts, 0);
});

test("the ticket prompt reads the ticket first, then plans the change without making it", () => {
  const prompt = ticketKickoffPrompt("https://linear.app/example/issue/DEMO-4224/add-demo-payment-option");
  assert.match(
    prompt,
    /^Read this https:\/\/linear\.app\/example\/issue\/DEMO-4224\/add-demo-payment-option and its comments\. Do not action it yet\./,
  );
  assert.match(prompt, /Read the affected repositories/);
  assert.match(prompt, /do not make any changes yet/i);
});

test("with PRs already made, the ticket prompt lists them and plans only what is left", () => {
  const prs = ["https://github.com/ExampleOrg/core/pull/2260", "https://github.com/ExampleOrg/web/pull/1857"];
  const prompt = ticketKickoffPrompt("https://linear.app/example/issue/DEMO-4214/refunds", prs);
  assert.match(prompt, /^Read this https:\/\/linear\.app\/example\/issue\/DEMO-4214\/refunds and its comments/);
  assert.match(
    prompt,
    /already started:\nhttps:\/\/github\.com\/ExampleOrg\/core\/pull\/2260\nhttps:\/\/github\.com\/ExampleOrg\/web\/pull\/1857\n/,
  );
  assert.match(prompt, /completed work and remaining tasks/);
  assert.doesNotMatch(prompt, /figure out what needs to change/);
});

test("the PR prompt reads the PR and its reviews, then works out what is left without changing anything", () => {
  const prompt = prKickoffPrompt("https://github.com/ExampleOrg/web/pull/1856");
  assert.match(
    prompt,
    /^Read this https:\/\/github\.com\/ExampleOrg\/web\/pull\/1856, its description and its review comments\. Do not action it yet\./,
  );
  assert.match(prompt, /Read the affected code and tests/);
  assert.match(prompt, /do not make any changes yet/i);
});

test("a new session's prompt is one CLI argument after --, so text that looks like an option stays text", () => {
  const prompt = "--dangerously-skip-permissions\nPlan only the web part.";
  const args = newSessionArguments("DEMO-4214 plan", prompt);
  assert.deepEqual(args.slice(-2), ["--", prompt]);
  assert.equal(args.filter((arg) => arg === prompt).length, 1);
  assert.ok(!newSessionArguments("Mondash", undefined).includes("--"));
});
