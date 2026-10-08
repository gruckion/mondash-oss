import assert from "node:assert/strict";
import { test } from "node:test";
import { startSectionStream, type Connection, type SectionTimes, type StreamFetch } from "./section-stream";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const timing = { idleMs: 100, retryMs: 50, maxRetryMs: 1000 };
const section = {
  version: 1,
  section: "issues",
  generatedAt: "2026-09-28T10:00:00Z",
  updatedAt: "2026-09-28T09:59:00Z",
  stale: false,
  groups: [],
};

/** A Mac that answers each stream request with a body the test writes to, and an app that starts in front. */
function harness(versions: ReadonlyMap<string, string> = new Map(), reachable = true) {
  const urls: string[] = [];
  const connections: Connection[] = [];
  const sections: string[] = [];
  const times: SectionTimes[] = [];
  const unreadable: (string | undefined)[] = [];
  const listeners = new Set<(state: string) => void>();
  const appState = {
    currentState: "active",
    addEventListener: (_type: "change", listener: (state: string) => void) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
  };
  let send = (_text: string) => {};
  const fetch: StreamFetch = async (url, { signal }) => {
    urls.push(url);
    if (!reachable) throw new Error("unreachable");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        send = (text) => controller.enqueue(new TextEncoder().encode(text));
        signal.addEventListener("abort", () => controller.error(new Error("aborted")));
      },
    });
    return { ok: true, status: 200, body };
  };
  const stop = startSectionStream({
    server: "http://mac",
    fetch,
    appState,
    versions,
    timing,
    onSection: (value, event) => sections.push(`${value.section}:${event}`),
    onTimes: (value) => times.push(value),
    onUnreadable: (name) => unreadable.push(name),
    onConnection: (connection) => connections.push(connection),
  });
  return {
    urls,
    connections,
    sections,
    times,
    unreadable,
    stop,
    send: (text: string) => send(text),
    appState: (state: string) => {
      appState.currentState = state;
      listeners.forEach((listener) => listener(state));
    },
  };
}

test("a connection that goes quiet is dropped as down and opened again", async () => {
  const mac = harness();
  await wait(60);
  mac.send(": alive\n\n");
  await wait(60);
  assert.deepEqual(mac.connections, ["live"], "a keep-alive holds the connection open");
  await wait(60);
  assert.deepEqual(mac.connections, ["live", "down"]);
  await wait(60);
  assert.equal(mac.urls.length, 2);
  assert.deepEqual(mac.connections, ["live", "down", "live"]);
  mac.stop();
});

test("the background marks the stream connecting, not down, and the return asks only for what changed", async () => {
  const mac = harness(new Map([["inbox", "aaaa"]]));
  await wait(5);
  mac.send(`data: ${JSON.stringify({ version: "bbbb", section })}\n\n`);
  await wait(5);
  mac.appState("background");
  await wait(timing.retryMs + 10);
  assert.deepEqual(mac.connections, ["live", "connecting"], "the aborted connection does not report down or retry");
  assert.equal(mac.urls.length, 1);
  mac.appState("active");
  await wait(5);
  assert.deepEqual(mac.connections, ["live", "connecting", "live"]);
  assert.equal(mac.urls[1], `http://mac/api/stream?have=${encodeURIComponent("inbox:aaaa,issues:bbbb")}`);
  assert.equal(mac.sections.length, 1);
  mac.stop();
});

test("a times event is passed on, an unreadable event is reported by section, and an unknown one is skipped", async () => {
  const mac = harness();
  await wait(5);
  const times = { section: "inbox", updatedAt: "2026-09-28T10:01:00Z", stale: true };
  mac.send(
    [
      `data: ${JSON.stringify({ times })}`,
      `data: ${JSON.stringify({ version: "cccc", section: { ...section, section: "reviews", groups: "no" } })}`,
      "data: {not json",
      `data: ${JSON.stringify({ patch: {} })}`,
      "",
    ].join("\n\n") + "\n",
  );
  await wait(5);
  assert.deepEqual(mac.times, [times]);
  assert.deepEqual(mac.unreadable, ["reviews", undefined]);
  assert.deepEqual(mac.sections, []);
  assert.deepEqual(mac.connections, ["live"]);
  mac.stop();
});

test("coming back to the front while a retry waits replaces the retry instead of adding one", async () => {
  const mac = harness(new Map(), false);
  await wait(5);
  assert.deepEqual(mac.connections, ["down"]);
  mac.appState("active");
  await wait(5);
  assert.equal(mac.urls.length, 2);
  // The first retry was due at 50 ms; the second attempt's own retry waits 100 ms.
  await wait(60);
  assert.equal(mac.urls.length, 2);
  mac.stop();
});
