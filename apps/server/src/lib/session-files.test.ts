import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { workspaceFiles } from "./session-files";
import { readAttachment } from "./session-attachments";

test("project file browsing keeps folders, reads UTF-8 source, and excludes hidden files, dependencies and symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "mondash-files-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "src", "café.ts"), 'const café = "☕";\n');
    await writeFile(join(root, ".env"), "SECRET=private");
    await writeFile(join(root, "node_modules", "module.ts"), "hidden dependency");
    await symlink(join(root, ".env"), join(root, "src", "escape.ts"));
    const tree = await workspaceFiles(root);
    assert.deepEqual(
      [...tree.sources.values()].map((file) => file.attachment.path),
      ["src/café.ts"],
    );
    const source = [...tree.sources.values()][0]!;
    const data = await readAttachment(source);
    assert.equal(Buffer.from(data.data, "base64").toString("utf8"), 'const café = "☕";\n');
    assert.equal(data.mediaType, "text/plain");
    const outside = await mkdtemp(join(tmpdir(), "mondash-outside-"));
    try {
      await writeFile(join(outside, "private.ts"), "private outside file");
      await rm(source.source);
      await symlink(join(outside, "private.ts"), source.source);
      await assert.rejects(readAttachment(source), /outside the session project/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
    await writeFile(join(root, "Dockerfile"), "FROM alpine\n");
    const docker = [...(await workspaceFiles(root)).sources.values()].find(
      (file) => file.attachment.name === "Dockerfile",
    )!;
    assert.equal((await readAttachment(docker)).mediaType, "text/plain");
    assert.ok(!JSON.stringify([...tree.sources.values()].map((file) => file.attachment)).includes(root));
    assert.equal(tree.truncated, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
