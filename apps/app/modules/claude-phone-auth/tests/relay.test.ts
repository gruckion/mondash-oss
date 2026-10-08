import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test(
  "the native phone relay rejects mismatched/repeated state and keeps a slow valid callback open until Mac verification finishes",
  { skip: process.platform !== "darwin", timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "mondash-native-callback-"));
    const binary = join(directory, "probe");
    const forwarded: unknown[] = [];
    const mac = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        forwarded.push(await request.json());
        await Bun.sleep(11_000);
        return Response.json({ state: "connected" });
      },
    });
    const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const callbackPort = reserved.port!;
    reserved.stop(true);
    try {
      const compiled = Bun.spawn(
        [
          "xcrun",
          "swiftc",
          "-swift-version",
          "5",
          fileURLToPath(new URL("../ios/ClaudeCallbackRelay.swift", import.meta.url)),
          fileURLToPath(new URL("main.swift", import.meta.url)),
          "-o",
          binary,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const diagnostics = await new Response(compiled.stderr).text();
      assert.equal(await compiled.exited, 0, diagnostics);
      const probe = Bun.spawn([binary, String(callbackPort), `http://127.0.0.1:${mac.port}/callback`], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const failures = await new Response(probe.stderr).text();
      assert.equal(await probe.exited, 0, failures);
      assert.deepEqual(forwarded, [{ code: "accepted", state: "expected-state" }]);
    } finally {
      mac.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
