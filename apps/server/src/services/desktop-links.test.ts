import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { makeDesktopLinkOpener } from "./desktop-links";

function harness(options: { missing?: boolean; platform?: string; workspace?: { team: string; url: string } } = {}) {
  const launches: { bundle: string; url: string }[] = [];
  const open = makeDesktopLinkOpener({
    platform: options.platform ?? "darwin",
    workspace: Effect.succeed(options.workspace),
    launch: async (bundle, url) => {
      launches.push({ bundle, url });
      if (options.missing) throw new Error("LaunchServices could not find the app");
    },
  });
  return { launches, open: (url: string) => Effect.runPromise(open(url)) };
}

test("Linear and Notion target their desktop apps and retain the exact destination", async () => {
  const h = harness();
  assert.equal(await h.open("https://linear.app/example/issue/DEMO-123?comment=c#reply"), true);
  assert.equal(await h.open("https://app.notion.com/p/e0f15ad5d7b059ea8b9fa1710fbd7501?d=comment#block"), true);
  assert.deepEqual(h.launches, [
    { bundle: "com.linear", url: "linear://example/issue/DEMO-123?comment=c#reply" },
    {
      bundle: "notion.id",
      url: "notion://www.notion.so/e0f15ad5d7b059ea8b9fa1710fbd7501?d=comment&deepLinkOpenNewTab=true#block",
    },
  ]);
});

test("missing apps and launch failures request browser fallback", async () => {
  const h = harness({ missing: true });
  assert.equal(await h.open("https://linear.app/example/issue/DEMO-123"), false);
  assert.equal(h.launches.length, 1);
});

test("Slack parent and reply links keep their workspace, message and parent thread", async () => {
  const h = harness({ workspace: { team: "T1", url: "https://examplehq.slack.com/" } });
  assert.equal(await h.open("https://examplehq.slack.com/archives/C1/p1789747637478879"), true);
  assert.equal(
    await h.open("https://examplehq.slack.com/archives/C1/p1789750000000001?thread_ts=1789747637.000001"),
    true,
  );
  assert.deepEqual(
    h.launches.map(({ url }) => url),
    [
      "slack://channel?team=T1&id=C1&message=1789747637.478879&thread_ts=1789747637.478879",
      "slack://channel?team=T1&id=C1&message=1789750000.000001&thread_ts=1789747637.000001",
    ],
  );
});

test("unknown Slack accounts, another workspace and unsupported destinations never launch an app", async () => {
  const h = harness({ workspace: { team: "T1", url: "https://examplehq.slack.com/" } });
  for (const url of [
    "https://other.slack.com/archives/C1/p1789747637478879",
    "https://www.notion.com/help",
    "https://github.com/example/app/pull/1#discussion",
    "https://linear.app.evil.test/example/issue/DEMO-1",
    "linear://example/issue/DEMO-1",
  ])
    assert.equal(await h.open(url), false);
  assert.deepEqual(h.launches, []);
  assert.equal(await harness().open("https://examplehq.slack.com/archives/C1/p1789747637478879"), false);
});

test("non-Mac servers never attempt LaunchServices", async () => {
  const h = harness({ platform: "linux" });
  assert.equal(await h.open("https://linear.app/example/issue/DEMO-1"), false);
  assert.deepEqual(h.launches, []);
});
