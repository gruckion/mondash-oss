import assert from "node:assert/strict";
import { test } from "node:test";
import { isMacBrowser } from "./claude-target";
import { openExternalLink } from "./open-link";

function harness(platform = "web", userAgent = "Macintosh", maxTouchPoints = 0, result: boolean | Error = true) {
  const actions: { kind: string; url: string }[] = [];
  const record = (kind: string, url: string) => {
    actions.push({ kind, url });
  };
  return {
    actions,
    open: (url: string) =>
      openExternalLink(url, {
        platform,
        macDesktop: platform === "web" && isMacBrowser(userAgent, maxTouchPoints),
        openNative: async (url) => record("native", url),
        openWeb: (url) => record("web", url),
        openFallback: (url) => record("fallback", url),
        openDesktop: async (url) => {
          record("desktop", url);
          if (result instanceof Error) throw result;
          return { opened: result };
        },
      }),
  };
}

const urls = [
  "https://linear.app/example/issue/DEMO-123?comment=c#reply",
  "https://app.notion.com/p/e0f15ad5d7b059ea8b9fa1710fbd7501?d=c#block",
  "https://examplehq.slack.com/archives/C1/p1789750000000001?thread_ts=1789747637.000001&cid=C1",
];

test("Mac provider clicks launch the desktop app without opening a browser tab", async () => {
  const h = harness();
  for (const url of urls) await h.open(url);
  assert.deepEqual(
    h.actions,
    urls.map((url) => ({ kind: "desktop", url })),
  );
});

test("missing apps, older backends and failed requests fall back to the same HTTPS destination", async () => {
  for (const result of [false, new Error("offline"), new Error("404")]) {
    const h = harness("web", "Macintosh", 0, result);
    await h.open(urls[0]);
    assert.deepEqual(h.actions, [
      { kind: "desktop", url: urls[0] },
      { kind: "fallback", url: urls[0] },
    ]);
  }
});

test("phone web, iPad desktop mode and other desktop operating systems keep their web handling", async () => {
  for (const [agent, touch] of [
    ["iPhone like Mac OS X", 5],
    ["Macintosh", 5],
    ["Windows NT", 0],
  ] as const) {
    const h = harness("web", agent, touch);
    for (const url of [...urls, "https://github.com/example/app/pull/1#discussion"]) await h.open(url);
    assert.ok(h.actions.every(({ kind }) => kind === "web"));
    assert.equal(h.actions.length, 4);
  }
});

test("native iPhone and Android always use native HTTPS opening even for a Mac-looking user agent", async () => {
  for (const platform of ["ios", "android"]) {
    const h = harness(platform);
    for (const url of [...urls, "https://github.com/example/app/pull/1#discussion"]) await h.open(url);
    assert.ok(h.actions.every(({ kind }) => kind === "native"));
    assert.equal(h.actions.length, 4);
  }
});

test("GitHub and unrelated links stay on desktop web; invalid and app-scheme inputs are rejected", async () => {
  const h = harness();
  for (const url of ["https://github.com/example/app/pull/1#discussion", "https://linear.app.evil.test/path"])
    await h.open(url);
  assert.ok(h.actions.every(({ kind }) => kind === "web"));
  for (const url of ["linear://example/issue/DEMO-1", "https://[bad", "javascript:alert(1)"])
    await assert.rejects(h.open(url), /supported web address/);
  assert.equal(h.actions.length, 2);
});

test("Slack parent links still explicitly open their thread on phones", async () => {
  const h = harness("ios");
  await h.open("https://examplehq.slack.com/archives/C1/p1789747637478879");
  assert.deepEqual(h.actions, [
    {
      kind: "native",
      url: "https://examplehq.slack.com/archives/C1/p1789747637478879?thread_ts=1789747637.478879&cid=C1",
    },
  ]);
});
