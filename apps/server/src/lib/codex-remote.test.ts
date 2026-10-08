import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHATGPT_APP_URL,
  createCodexRemoteOpener,
  hasCodexRegistration,
  type CodexRemoteDependencies,
} from "./codex-remote.ts";
import { settle } from "./settle.ts";

const id = "FF72D97B-08D1-5D66-B204-0574B0A0BAC6";
const session = { id, tool: "codex", title: "Investigate refund failures" };
function harness(overrides: Partial<CodexRemoteDependencies> = {}) {
  const calls = { find: 0, registered: 0, running: 0 };
  const opener = createCodexRemoteOpener({
    find: async () => {
      calls.find++;
      return session;
    },
    registered: async () => {
      calls.registered++;
      return true;
    },
    running: async () => {
      calls.running++;
      return true;
    },
    ...overrides,
  });
  return { open: (value: string) => settle(opener(value)), calls };
}

test("Codex handoff uses the verified app URL and does not claim exact session routing or live connectivity", async () => {
  assert.deepEqual(await harness().open(id), {
    ok: true,
    url: CHATGPT_APP_URL,
    handoff: "app",
    remoteStatus: "registered",
    sessionTitle: session.title,
  });
});

test("invalid IDs cannot cause local lookups or readiness checks", async () => {
  const h = harness();
  for (const value of ["", "../secret", `${id}; command`]) assert.equal((await h.open(value)).ok, false);
  assert.deepEqual(h.calls, { find: 0, registered: 0, running: 0 });
});

test("missing, mismatched and Claude sessions cannot enter a Codex handoff", async () => {
  for (const found of [undefined, { ...session, tool: "claude" }, { ...session, id: "another-session" }]) {
    const h = harness({ find: async () => found });
    assert.deepEqual(await h.open(id), {
      ok: false,
      message: "This Codex session is no longer available on your Mac.",
    });
    assert.equal(h.calls.registered, 0);
    assert.equal(h.calls.running, 0);
  }
});

test("registration is not inferred from an old installation ID alone", () => {
  const registered = {
    "electron-local-remote-control-installation-id": id,
    "electron-local-remote-control-environment-id": "env_example",
  };
  assert.equal(hasCodexRegistration(registered), true);
  for (const value of [
    null,
    {},
    { ...registered, "electron-local-remote-control-environment-id": null },
    { ...registered, "electron-local-remote-control-environment-id": "https://example.com" },
  ]) {
    assert.equal(hasCodexRegistration(value), false);
  }
});

test("unregistered and stopped desktop hosts return actionable errors without an app handoff", async () => {
  const unregistered = harness({ registered: async () => false });
  assert.deepEqual(await unregistered.open(id), {
    ok: false,
    message: "Set up Remote in the ChatGPT desktop app’s Settings > Connections on your Mac first.",
  });
  assert.equal(unregistered.calls.running, 0);
  assert.deepEqual(await harness({ running: async () => false }).open(id), {
    ok: false,
    message: "Open the ChatGPT desktop app on your Mac, then try again.",
  });
});

test("unexpected readiness errors propagate for the route's generic 503 response", async () => {
  await assert.rejects(
    harness({
      running: async () => {
        throw new Error("ps failed");
      },
    }).open(id),
    /ps failed/,
  );
});
