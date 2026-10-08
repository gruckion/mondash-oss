import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultProfile } from "./profile";

test("actual fetchers support personal repositories and independent organization/team scopes", async () => {
  const root = await mkdtemp(join(tmpdir(), "mondash-query-"));
  try {
    for (const organizations of [[], ["StudioOrg", "OtherOrg"]]) {
      const blank = defaultProfile();
      const selected = {
        ...blank,
        directory: { me: "alex", people: [{ name: "Alex Doe", github: "alex" }] },
        integrations: { ...blank.integrations, github: true },
        workspace: {
          ...blank.workspace,
          organizations,
          reviewTeams: organizations.map((organization) => ({ organization, slug: "reviewers" })),
        },
      };
      const path = join(root, "profile.json");
      await writeFile(path, JSON.stringify(selected));
      const p = Bun.spawn([process.execPath, "apps/server/src/query-scope-runner.ts"], {
        env: { PATH: process.env.PATH!, HOME: root, MONDASH_PROFILE: path },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      expect(code, err).toBe(0);
      const queries: string[] = JSON.parse(out.trim().split("\n").at(-1)!);
      expect(queries.every((query) => !query.includes("ExampleOrg"))).toBe(true);
      const open = queries.find((query) => query.includes("sort:updated-desc"))!;
      if (!organizations.length) expect(open.includes("org:")).toBe(false);
      else
        for (const organization of organizations) {
          expect(open).toContain(`org:${organization}`);
          expect(queries.some((query) => query.includes(`team-review-requested:${organization}/reviewers`))).toBe(true);
        }
      for (const query of queries.filter((query) => query.includes("requested: search"))) {
        expect(query).toContain('query: "is:open is:pr review-requested:@me"');
        expect(query).toContain('query: "is:open is:pr reviewed-by:@me"');
        expect(query).not.toContain(" OR ");
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
