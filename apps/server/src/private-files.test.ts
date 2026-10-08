import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateUpdate } from "./private-files";

test("private updates preserve all writes across independent processes and recover a killed writer", async () => {
  const root = await mkdtemp(join(tmpdir(), "mondash-process-lock-"));
  const path = join(root, "profile.json");
  const source = new URL("./private-files.ts", import.meta.url).pathname;
  const child = (code: string) =>
    Bun.spawn([process.execPath, "-e", `import { privateUpdate } from ${JSON.stringify(source)}; ${code}`], {
      stdout: "ignore",
      stderr: "pipe",
    });
  try {
    await privateUpdate(path, () => ({ count: 0 }));
    const children = Array.from({ length: 8 }, () =>
      child(`for (let i=0;i<3;i++) await privateUpdate(${JSON.stringify(path)}, v => ({ count: v.count+1 }));`),
    );
    for (const process of children) expect(await process.exited, await new Response(process.stderr).text()).toBe(0);
    expect(JSON.parse(await readFile(path, "utf8")).count).toBe(24);
    const marker = join(root, "locked");
    const interrupted = child(
      `import { writeFileSync } from 'node:fs'; await privateUpdate(${JSON.stringify(path)}, () => { writeFileSync(${JSON.stringify(marker)}, 'ready'); while(true) {} });`,
    );
    for (let i = 0; i < 100 && !Bun.file(marker).size; i++) await Bun.sleep(10);
    expect(await Bun.file(marker).exists()).toBe(true);
    interrupted.kill("SIGKILL");
    await interrupted.exited;
    expect(JSON.parse(await readFile(path, "utf8")).count).toBe(24);
    await expect(privateUpdate(path, () => ({ count: 100 }))).rejects.toThrow("locked");
    // All writers have stopped: explicit stale-lock recovery retains the current valid value.
    await rm(`${path}.lock`);
    await privateUpdate(path, (value) => value);
    expect(JSON.parse(await readFile(path, "utf8")).count).toBe(24);
    await writeFile(path, "broken JSON");
    await expect(privateUpdate(path, () => ({ count: 0 }))).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("broken JSON");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
