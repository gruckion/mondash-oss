import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ActionError } from "./action-error.ts";
import { resumeFailure } from "./claude-remote.ts";
import { settle } from "./settle.ts";
import {
  claudeReviewArguments,
  claudeReviewName,
  claudeReviewPrompt,
  createClaudeReviewLauncher,
  createClaudeReviewRegistry,
  findClaudeReviewSession,
  previewClaudeReview,
  type ClaudeReviewDependencies,
  type ClaudeReviewLaunch,
} from "./claude-review.ts";

const first = "https://github.com/ExampleOrg/core/pull/123";
const second = "https://github.com/ExampleOrg/web/pull/456";
const scope = { urls: [first, second], cwd: "/test/project", title: "PR risk review: core#123 + web#456" };
const id = "FF72D97B-08D1-5D66-B204-0574B0A0BAC6";
const record: ClaudeReviewLaunch = { ...scope, launchId: id, createdAt: "2026-09-24T00:00:00.000Z", state: "starting" };
const url = "https://claude.ai/code/session_MondashTest";

const launcher = (deps: ClaudeReviewDependencies) => {
  const launch = createClaudeReviewLauncher(deps);
  return (input: Parameters<typeof launch>[0]) => settle(launch(input));
};

function harness() {
  let saved: ClaudeReviewLaunch | undefined;
  let time = 0;
  let connected = false;
  const starts: { record: ClaudeReviewLaunch; prompt: string }[] = [];
  const lookedUp: string[] = [];
  const resumed: string[] = [];
  const deps: ClaudeReviewDependencies = {
    claim: async () => {
      const fresh = !saved;
      saved ??= { ...record };
      return { record: saved, fresh };
    },
    save: async (value) => {
      saved = value;
    },
    start: async (value, prompt) => {
      starts.push({ record: value, prompt });
    },
    find: async () => id,
    url: async (value) => {
      lookedUp.push(value);
      return connected ? url : undefined;
    },
    resume: async (value) => {
      resumed.push(value);
      return url;
    },
    now: () => time,
    sleep: async () => {
      time += 10_000;
    },
  };
  return {
    deps,
    starts,
    lookedUp,
    resumed,
    connect: () => {
      connected = true;
    },
    launch: launcher(deps),
  };
}

test("launch supplies all PRs in one review prompt, unique launch identity, Remote Control and auto permissions", () => {
  const prompt = claudeReviewPrompt(scope.urls);
  assert.match(
    prompt,
    /^Code review\nhttps:\/\/github.com\/ExampleOrg\/core\/pull\/123\nhttps:\/\/github.com\/ExampleOrg\/web\/pull\/456/,
  );
  assert.match(prompt, /Review these pull requests together as one change\./);
  assert.match(prompt, /Return the review in this conversation/);
  assert.match(prompt, /Changes and external actions require a separate request/);
  assert.match(prompt, /Support findings with evidence and file links/);
  assert.deepEqual(claudeReviewArguments(record, prompt), [
    "--bg",
    "--remote-control",
    claudeReviewName(record),
    "--name",
    claudeReviewName(record),
    "--permission-mode",
    "auto",
    "--",
    prompt,
  ]);
});

test("a single PR gets singular wording", () => {
  const prompt = claudeReviewPrompt([first]);
  assert.match(prompt, /Review this pull request\./);
  assert.doesNotMatch(prompt, /these pull requests|each PR/);
});

test("simultaneous taps on either related PR share one launch and exact-session URL", async () => {
  const h = harness();
  h.connect();
  const results = await Promise.all([h.launch(scope), h.launch({ ...scope, urls: [second] })]);
  assert.equal(h.starts.length, 1);
  assert.equal(
    results.every((result) => result.ok && result.sessionId === id && result.url === url),
    true,
  );
  assert.deepEqual(h.lookedUp, [id]);
});

test("connection timeout and a recreated launcher reuse persisted reservation without launching twice", async () => {
  const h = harness();
  const waiting = await h.launch(scope);
  assert.equal(waiting.ok, false);
  assert.ok(!waiting.ok && waiting.pending && waiting.sessionId === id);
  h.connect();
  const restarted = launcher(h.deps);
  assert.deepEqual(await restarted(scope), { ok: true, sessionId: id, url, reused: true });
  assert.equal(h.starts.length, 1);
});

test("a CLI launch timeout keeps its reservation even when no process has appeared yet", async () => {
  const h = harness();
  h.deps.start = async (value, prompt) => {
    h.starts.push({ record: value, prompt });
    throw new Error("spawn timed out");
  };
  const waiting = await h.launch(scope);
  assert.ok(!waiting.ok && waiting.pending);
  h.connect();
  const resumed = await launcher(h.deps)(scope);
  assert.ok(resumed.ok);
  assert.equal(h.starts.length, 1);
});

test("previously connected reviews resume the same session instead of starting a new review", async () => {
  const h = harness();
  h.connect();
  await h.launch(scope);
  const result = await h.launch(scope);
  assert.ok(result.ok && result.reused);
  assert.deepEqual(h.resumed, [id]);
  assert.equal(h.starts.length, 1);
});

test("invalid PR URLs and relative cwd are rejected without reserving or launching", async () => {
  const h = harness();
  let claims = 0;
  h.deps.claim = async () => {
    claims++;
    return { record, fresh: true };
  };
  for (const input of [
    { ...scope, urls: ["https://github.com.evil.test/ExampleOrg/core/pull/1"] },
    { ...scope, urls: [first + ";rm"] },
    { ...scope, urls: [] },
    { ...scope, cwd: "../project" },
  ])
    assert.equal((await h.launch(input)).ok, false);
  assert.equal(claims, 0);
});

test("persistent registry claims overlapping scopes across connections and survives reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mondash-review-"));
  const file = join(dir, "registry.db");
  const a = createClaudeReviewRegistry(file);
  const b = createClaudeReviewRegistry(file);
  try {
    const initial = a.claim(scope);
    const overlapping = b.claim({ ...scope, urls: [second] });
    assert.equal(initial.fresh, true);
    assert.equal(overlapping.fresh, false);
    assert.equal(initial.record.launchId, overlapping.record.launchId);
    a.save({ ...initial.record, state: "ready", url });
    assert.equal(b.list()[0].url, url);
    a.close();
    const reopened = createClaudeReviewRegistry(file);
    try {
      const retry = reopened.claim(scope);
      assert.equal(retry.fresh, false);
      assert.equal(retry.record.launchId, initial.record.launchId);
    } finally {
      reopened.close();
    }
  } finally {
    b.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("newly discovered PRs are not silently claimed as part of an existing review", async () => {
  const h = harness();
  h.connect();
  await h.launch(scope);
  const result = await h.launch({ ...scope, urls: [...scope.urls, "https://github.com/ExampleOrg/web/pull/789"] });
  assert.ok(!result.ok && /only some/.test(result.message));
  assert.equal(h.starts.length, 1);
});

test("managed background UUID is discovered only from a unique exact marker and cwd", () => {
  const entry = { sessionId: id, name: claudeReviewName(record), cwd: record.cwd, kind: "background" };
  assert.equal(findClaudeReviewSession(record, [entry]), id);
  assert.equal(findClaudeReviewSession(record, [{ ...entry, cwd: "/other" }]), undefined);
  assert.equal(findClaudeReviewSession(record, [{ ...entry, name: record.title }]), undefined);
  assert.equal(
    findClaudeReviewSession(record, [entry, { ...entry, sessionId: "F828D7E6-F804-57F2-AEC7-131E5D46DE3D" }]),
    undefined,
  );
});

test("definite spawn failure can retry safely while ambiguous failure cannot duplicate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mondash-review-failure-"));
  const store = createClaudeReviewRegistry(join(dir, "registry.db"));
  try {
    const h = harness();
    h.deps.claim = async (input) => store.claim(input);
    h.deps.save = async (value) => store.save(value);
    let attempts = 0;
    h.deps.start = async () => {
      if (++attempts === 1) throw Object.assign(new Error("not installed"), { code: "ENOENT" });
    };
    assert.equal((await h.launch(scope)).ok, false);
    assert.equal(store.list()[0].state, "failed");
    h.connect();
    assert.equal((await h.launch(scope)).ok, true);
    assert.equal(attempts, 2);
    assert.equal(store.list().length, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed resume keeps its words for the person and the original error as the cause", async () => {
  const h = harness();
  h.connect();
  await h.launch(scope);
  const trust = resumeFailure(Object.assign(new Error("Command failed"), { stderr: "not trusted" }));
  h.deps.resume = async () => {
    throw trust;
  };
  const resumed = await createClaudeReviewLauncher(h.deps)(scope).catch((error: unknown) => error);
  assert.ok(resumed instanceof ActionError);
  assert.equal(resumed.message, trust.message);
  assert.equal(resumed.review?.sessionId, id);
  assert.equal(resumed.cause, trust);

  const fresh = harness();
  const broken = new Error("agents --json failed");
  fresh.deps.find = async () => {
    throw broken;
  };
  const failed = await createClaudeReviewLauncher(fresh.deps)(scope).catch((error: unknown) => error);
  assert.ok(failed instanceof ActionError);
  assert.equal(failed.review?.pending, true);
  assert.equal(failed.cause, broken);
});

test("a new review is reserved even when one already covers the PR, and both stay listed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mondash-review-"));
  const registry = createClaudeReviewRegistry(join(dir, "registry.db"));
  try {
    const first = registry.claim(scope);
    registry.save({ ...first.record, state: "ready", url });
    const again = registry.claim(scope);
    const another = registry.claim(scope, true);
    assert.equal(again.record.launchId, first.record.launchId);
    assert.equal(another.fresh, true);
    assert.notEqual(another.record.launchId, first.record.launchId);
    assert.equal(registry.list().length, 2);
  } finally {
    registry.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the prompt names related PRs that are not ready and tells the review to leave them alone", () => {
  const waiting = "https://github.com/ExampleOrg/core/pull/2377";
  const prompt = claudeReviewPrompt([first], [waiting]);
  assert.match(prompt, /not ready for review yet/);
  assert.ok(prompt.includes(waiting));
  assert.doesNotMatch(claudeReviewPrompt([first]), /not ready for review yet/);
});

/** A harness whose reservations live in a real registry, as the server's do. */
async function withRegistry(
  use: (h: ReturnType<typeof harness>, registry: ReturnType<typeof createClaudeReviewRegistry>) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "mondash-review-preview-"));
  const registry = createClaudeReviewRegistry(join(dir, "registry.db"));
  try {
    const h = harness();
    h.deps.claim = async (input, startNew) => registry.claim(input, startNew);
    h.deps.save = async (value) => registry.save(value);
    h.connect();
    await use(h, registry);
  } finally {
    registry.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("a review's prompt preview is exactly the first message its start sends", async () => {
  await withRegistry(async (h, registry) => {
    const waiting = "https://github.com/ExampleOrg/core/pull/2377";
    const input = { ...scope, urls: [second, first, second], notReady: [waiting] };
    const preview = previewClaudeReview(registry.list(), input);
    assert.deepEqual(preview, {
      urls: [first, second],
      notReady: [waiting],
      prompt: claudeReviewPrompt([first, second], [waiting]),
      reopens: false,
    });
    const launch = createClaudeReviewLauncher(h.deps);
    await launch(input);
    assert.equal(h.starts[0].prompt, preview.prompt);

    // The review now exists, so a start reopens it and sends nothing, edited or not.
    assert.equal(previewClaudeReview(registry.list(), input).reopens, true);
    await launch(input, false, "An edited prompt");
    assert.equal(h.starts.length, 1);

    const another = previewClaudeReview(registry.list(), input, true);
    assert.equal(another.reopens, false);
    await launch(input, true);
    assert.equal(h.starts[1].prompt, another.prompt);
  });
});

test("an edited prompt replaces the first message of a new review, as one CLI argument after --", async () => {
  await withRegistry(async (h) => {
    const edited = "--help\nOnly review the migration.";
    await createClaudeReviewLauncher(h.deps)(scope, false, edited);
    assert.equal(h.starts[0].prompt, edited);
    assert.deepEqual(claudeReviewArguments(h.starts[0].record, edited).slice(-2), ["--", edited]);
  });
});

test("a review's prompt preview refuses a scope that an existing review only partly covers, as the start does", async () => {
  await withRegistry(async (h, registry) => {
    await createClaudeReviewLauncher(h.deps)({ ...scope, urls: [first] });
    assert.throws(() => previewClaudeReview(registry.list(), scope), /only some/);
  });
});
