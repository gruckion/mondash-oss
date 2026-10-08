import { test, expect } from "bun:test";
import { Effect, Option, Redacted } from "effect";
import { ServerConfig } from "./config";
import { coverage } from "./coverage";
import { defaultProfile } from "./profile";

test("missing, invalid, failed and stale provider checks never claim fresh coverage", async () => {
  const settings = await Effect.runPromise(ServerConfig.pipe(Effect.provide(ServerConfig.layer)));
  const selected = {
    ...defaultProfile(),
    integrations: { ...defaultProfile().integrations, github: true },
    directory: { me: "alex", people: [{ name: "Alex Doe", github: "alex" }] },
  };
  for (const [at, state, expected] of [
    [null, "connected", "unknown"],
    ["invalid", "connected", "unknown"],
    [new Date(0).toISOString(), "connected", "stale"],
    [new Date().toISOString(), "error", "error"],
    [new Date().toISOString(), "connected", "ready"],
  ] as const) {
    expect(
      coverage([{ name: "github", checkedAt: at, state }], { ...settings, linearApiKey: Option.none() }, selected).find(
        (source) => source.name === "github",
      )?.status,
    ).toBe(expected);
  }
  expect(coverage([], settings, defaultProfile()).every((source) => source.status === "disabled")).toBe(true);
});

test("Slack uses its search refresh deadline rather than the oldest search's age", async () => {
  const settings = await Effect.runPromise(ServerConfig.pipe(Effect.provide(ServerConfig.layer)));
  const selected = {
    ...defaultProfile(),
    integrations: { ...defaultProfile().integrations, slack: true },
    directory: { me: "UABC", people: [{ name: "Alex Doe", slack: "UABC" }] },
  };
  const now = Date.now();
  const connection = {
    name: "slack",
    checkedAt: new Date(now).toISOString(),
    lastSyncedAt: new Date(now - 45 * 60_000).toISOString(),
    state: "connected" as const,
  };
  const configured = { ...settings, slackClient: Option.some({ id: "test", secret: Redacted.make("test") }) };
  for (const [refreshDueAt, state, expected] of [
    [new Date(now + 10 * 60_000).toISOString(), "connected", "ready"],
    [new Date(now - 10 * 60_000).toISOString(), "connected", "stale"],
    [null, "connected", "unknown"],
    ["invalid", "connected", "unknown"],
    [new Date(now + 10 * 60_000).toISOString(), "error", "error"],
  ] as const) {
    const source = { ...connection, refreshDueAt, state };
    expect(coverage([source], configured, selected).find((item) => item.name === "slack")?.status).toBe(expected);
  }
});
