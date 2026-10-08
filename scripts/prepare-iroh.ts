/** Download verified native build inputs; vendor binaries/generated bindings stay ignored. */
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import dependency from "../apps/app/modules/mondash-iroh/dependency.json";

const root = resolve(import.meta.dir, "..");
const cache = resolve(root, ".cache/iroh");
const target = resolve(root, "apps/app/modules/mondash-iroh/ios");
await mkdir(cache, { recursive: true, mode: 0o700 });
await mkdir(resolve(target, "Vendor"), { recursive: true });
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function download(url: string, expected: string, path: string) {
  const file = Bun.file(path);
  if (await file.exists()) {
    if (hash(await file.bytes()) !== expected) throw new Error(`Cached SDK checksum failed: ${path}`);
    return;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Native SDK download failed (HTTP ${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (hash(bytes) !== expected) throw new Error("Native SDK checksum failed");
  await Bun.write(path, bytes);
}
const archive = resolve(cache, `iroh-${dependency.irohTag}.zip`);
await download(dependency.url, dependency.sha256, archive);
await download(
  `https://raw.githubusercontent.com/n0-computer/iroh-ffi/${dependency.gitCommit}/IrohLib/Sources/IrohLib/IrohLib.swift`,
  dependency.bindingSha256,
  resolve(target, "IrohLib.swift"),
);
const result = Bun.spawnSync(["/usr/bin/unzip", "-o", "-q", archive, "-d", resolve(target, "Vendor")]);
if (result.exitCode) throw new Error("Native SDK extraction failed");
console.log(`Prepared checksum-verified Iroh ${dependency.irohTag} native SDK`);
