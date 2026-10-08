import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** A process lock with bounded contention; a crashed writer leaves a lock that requires explicit recovery. */
export async function privateUpdate<A>(path: string, update: (before: unknown) => A): Promise<A> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const handle = await open(lock, "wx", 0o600);
      await handle.close();
      acquired = true;
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      await Bun.sleep(20);
    }
  }
  if (!acquired)
    throw new Error(`Configuration is locked: ${path}.lock. Stop all writers before removing a stale lock.`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const backupTemporary = `${temporary}.previous`;
  try {
    let before: unknown;
    try {
      before = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const next = update(before);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(next, null, 2) + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (before !== undefined) {
      const backup = await open(backupTemporary, "wx", 0o600);
      try {
        await backup.writeFile(JSON.stringify(before, null, 2) + "\n");
        await backup.sync();
      } finally {
        await backup.close();
      }
      await rename(backupTemporary, `${path}.previous`);
      await chmod(`${path}.previous`, 0o600);
    }
    await rename(temporary, path);
    await chmod(path, 0o600);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return next;
  } finally {
    await rm(temporary, { force: true });
    await rm(backupTemporary, { force: true });
    await rm(lock, { force: true });
  }
}
