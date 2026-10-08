// Run: node --test src/lib/dm-context.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { dmContext, dmPermalink } from "./dm-context.ts";

const msg = (user: string, text: string, ts = "1") => ({ user, text, ts });
const chat = (...texts: [string, string][]) => texts.map(([u, t], i) => msg(u, t, String(i)));

test("keeps work talk and its neighbours, drops the rest", () => {
  const messages = chat(
    ["me", "did you watch the game"],
    ["them", "yeah it was great"],
    ["them", "can you send an updated video for https://github.com/ExampleOrg/web/pull/1792"],
    ["me", "sure"],
    ["them", "the library closes early today"],
    // Six more, so the early small talk is outside the always-kept tail.
    ["me", "haha"],
    ["them", "what are you reading"],
    ["me", "a short novel"],
    ["them", "same"],
    ["me", "perhaps the mystery next"],
    ["them", "is it available"],
  );
  const kept = dmContext(messages, "me");
  assert.ok(kept.some((m) => m.includes("updated video")));
  assert.ok(
    kept.some((m) => m === "you: sure"),
    "the answer next to work talk is kept",
  );
  assert.ok(!kept.some((m) => m.includes("the game")), "small talk away from work talk is dropped");
});

test("the last few messages are always kept, so a short answer counts", () => {
  const messages = [
    ...chat(["them", "please review the PR"]),
    ...chat(["me", "ok"], ["them", "ta"], ["me", "hmm, checking"]),
  ];
  const kept = dmContext(messages, "me");
  assert.equal(kept.at(-1), "you: hmm, checking");
});

test("messages are labelled by who wrote them and a permalink points at the message", () => {
  assert.deepEqual(dmContext([msg("them", "merge conflict?")], "me"), ["them: merge conflict?"]);
  assert.equal(
    dmPermalink("https://examplehq.slack.com/", "DDEMO645CCC", "1790094259.006919"),
    "https://examplehq.slack.com/archives/DDEMO645CCC/p1790094259006919",
  );
});

test("ticket-only requests from any workspace survive outside the recent tail", () => {
  const messages = [msg("them", "APP-42 please"), ...Array.from({ length: 9 }, (_, i) => msg("me", `hello ${i}`))];
  assert.ok(dmContext(messages, "me").includes("them: APP-42 please"));
});
