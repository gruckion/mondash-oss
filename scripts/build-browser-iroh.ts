import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
const target = resolve(root, ".cache/browser-access/wasm-target");
const cli = resolve(root, ".cache/browser-access/tools/bin/wasm-bindgen");
async function run(args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(args, { cwd: root, env: { ...process.env, ...env }, stdout: "inherit", stderr: "inherit" });
  if (await child.exited) throw new Error(`Build failed: ${args[0]}`);
}
await mkdir(resolve(root, "apps/app/public/iroh"), { recursive: true });
await run(["rustup", "target", "add", "wasm32-unknown-unknown", "--toolchain", "stable"]);
if (!(await Bun.file(cli).exists()))
  await run([
    "cargo",
    "+stable",
    "install",
    "wasm-bindgen-cli",
    "--version",
    "0.2.122",
    "--locked",
    "--root",
    resolve(root, ".cache/browser-access/tools"),
  ]);
const compiler = (await Bun.file("/opt/homebrew/opt/llvm/bin/clang").exists())
  ? {
      CC_wasm32_unknown_unknown: "/opt/homebrew/opt/llvm/bin/clang",
      AR_wasm32_unknown_unknown: "/opt/homebrew/opt/llvm/bin/llvm-ar",
    }
  : {};
await run(
  [
    "cargo",
    "+stable",
    "build",
    "--locked",
    "--manifest-path",
    "apps/app/iroh-wasm/Cargo.toml",
    "--target",
    "wasm32-unknown-unknown",
    "--target-dir",
    target,
    "--release",
  ],
  compiler,
);
await run([
  cli,
  resolve(target, "wasm32-unknown-unknown/release/mondash_iroh.wasm"),
  "--out-dir",
  "apps/app/public/iroh",
  "--weak-refs",
  "--target",
  "web",
]);
