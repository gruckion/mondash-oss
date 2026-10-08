import { test, expect } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultProfile, decodeProfile, identityDirectory, profile, notionProperties } from "./profile";
import { PEOPLE, person, displayName, isMe } from "./lib/people";
import { privateUpdate } from "./private-files";
import legacy from "../test-legacy-profile.json";

test("production directory preserves every field, order and lookup of the 14-row compatibility mapping", () => {
  expect(PEOPLE).toEqual(legacy.directory.people);
  for (const row of legacy.directory.people)
    for (const key of [row.email, row.slack, row.github, row.name]) {
      expect(person(key.toUpperCase())).toEqual(row);
      expect(displayName(key)).toBe(`${row.name.split(" ")[0]} ${row.name.split(" ").at(-1)?.[0]}`);
    }
  expect(isMe(legacy.directory.people[0].github)).toBe(true);
});
test("GitHub-only self, aliases and duplicate names resolve by identity without name guessing", () => {
  const me = { name: "Alex Doe", github: "alex", aliases: ["alex@example.com"] };
  const d = identityDirectory({ me: "alex", people: [me, { name: "Alex Doe", slack: "OTHER" }] });
  expect(d.person("ALEX@EXAMPLE.COM")).toBe(d.self);
  expect(d.person("Alex Doe")).toBeUndefined();
  expect(() => identityDirectory({ me: "alex", people: [me, { name: "Other", github: "ALEX" }] })).toThrow("ambiguous");
});
test("generic install has no personal identity or network/workspace fallback and rejects malformed settings", () => {
  const blank = defaultProfile();
  expect(decodeProfile(blank)).toEqual(blank);
  expect(blank.directory.people).toEqual([]);
  expect(Object.values(blank.integrations).some(Boolean)).toBe(false);
  expect(() => decodeProfile({ ...blank, version: 2 })).toThrow();
  expect(() => decodeProfile({ ...blank, token: "do-not-store-secrets" })).toThrow();
  expect(() => decodeProfile({ ...blank, runtime: { ...blank.runtime, port: 65536 } })).toThrow();
});
test("real Notion property adapter preserves canonical compatibility columns", () => {
  const row = {
    url: "https://notion.so/example",
    Name: "Build",
    Status: profile.notion.scoping[0],
    Assign: '["user://me"]',
    Reviewer: "[]",
    "Effort (Days)": 3,
  };
  expect(notionProperties(row)).toEqual(row);
});
test("concurrent private updates serialize, retain a valid previous value, and reject invalid writes", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "mondash-profile-")), "profile.json");
  await privateUpdate(path, () => ({ count: 0 }));
  await Promise.all(
    Array.from({ length: 12 }, () =>
      privateUpdate(path, (before) => ({ count: (before as { count: number }).count + 1 })),
    ),
  );
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ count: 12 });
  expect(JSON.parse(await readFile(`${path}.previous`, "utf8"))).toEqual({ count: 11 });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  await expect(
    privateUpdate(path, () => {
      throw new Error("invalid");
    }),
  ).rejects.toThrow("invalid");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ count: 12 });
});

test("numeric Notion priority and effort remain valid canonical display values", () => {
  const row = notionProperties({ Name: "Build", Status: profile.notion.scoping[0], Priority: 2, Effort: 5 });
  expect(row.Priority).toBe("2");
  expect(row.Effort).toBe("5");
});
