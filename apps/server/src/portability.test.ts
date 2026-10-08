import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultProfile } from "./profile";

// Fresh module/service graph per profile; no mutation of shared module constants between tests.
test("real dashboard, inbox and live scheduler never invoke disabled adapters across 256 integration combinations", async () => {
  const root = await mkdtemp(join(tmpdir(), "mondash-graph-"));
  try {
    for (let mask = 0; mask < 256; mask++) {
      const names = [
        "github",
        "linear",
        "slack",
        "notion",
        "sessions",
        "classification",
        "notifications",
        "tracing",
      ] as const;
      const blank = defaultProfile();
      const profile = {
        ...blank,
        notion: { ...blank.notion, view: "https://notion.so/example?v=example" },
        directory: {
          me: "alex",
          people: [{ name: "Alex Doe", github: "alex", email: "alex@example.com", slack: "UABC" }],
        },
        integrations: {
          ...blank.integrations,
          ...Object.fromEntries(names.map((name, index) => [name, !!(mask & (1 << index))])),
        },
      };
      const path = join(root, `${mask}.json`);
      await writeFile(path, JSON.stringify(profile));
      const process = Bun.spawn([Bun.which("bun")!, "apps/server/src/provider-graph-runner.ts"], {
        env: { ...Bun.env, HOME: root, MONDASH_PROFILE: path },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      expect(code, stderr).toBe(0);
      const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
      if (profile.integrations.linear)
        expect(
          result.issueIds.some((id: string) => id.includes("APP-1")),
          `${mask}: Linear base survives failed GitHub enrichment`,
        ).toBe(true);
      for (const name of names.filter((name) => !["classification", "notifications", "tracing"].includes(name)))
        if (!profile.integrations[name]) {
          expect(result.calls[name], `${mask}: ${name}`).toBe(0);
          expect(result.shown).not.toContain(name);
        }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 240_000);
