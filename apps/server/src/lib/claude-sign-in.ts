import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeSignIn } from "@mondash/shared/contract";
import { ActionError } from "./action-error";
import { readClaudeAuthStatus } from "./claude-cli";

type Attempt = {
  status: ClaudeSignIn;
  process: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  finished: Promise<void>;
  callbackUrl?: URL;
  state?: string;
  dispose(): void;
  fail(): void;
};

/** The CLI owns OAuth and credential storage. The phone relays its loopback callback unchanged. */
export function createClaudeSignIn(executable: () => Promise<string>) {
  let current: Attempt | undefined;
  let starting: Promise<ClaudeSignIn> | undefined;
  const read = (id: string) => {
    if (!current || current.status.id !== id)
      throw new ActionError("This Claude sign-in is no longer available. Try signing in again.");
    return current;
  };
  async function start(): Promise<ClaudeSignIn> {
    if (current && ["waiting", "verifying"].includes(current.status.state)) {
      const attempt = current;
      await attempt.ready;
      return attempt.status;
    }
    const bin = await executable();
    const directory = await mkdtemp(join(tmpdir(), "mondash-claude-auth-"));
    const browser = join(directory, "browser");
    const captured = join(directory, "url");
    try {
      await writeFile(browser, '#!/bin/sh\nprintf %s "$1" > "$MONDASH_BROWSER_CAPTURE"\n', { mode: 0o700 });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    const child = spawn(bin, ["auth", "login", "--claudeai"], {
      env: { ...process.env, BROWSER: browser, MONDASH_BROWSER_CAPTURE: captured },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let ready!: () => void;
    let failed!: (error: ActionError) => void;
    let finished!: () => void;
    let polling: ReturnType<typeof setInterval> | undefined;
    let startup: ReturnType<typeof setTimeout> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const dispose = () => {
      clearInterval(polling);
      clearTimeout(startup);
      clearTimeout(expiry);
      void rm(directory, { recursive: true, force: true }).catch(() => {});
    };
    const attempt: Attempt = {
      status: { id: randomUUID(), state: "waiting", expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() },
      process: child,
      ready: new Promise((resolve, reject) => {
        ready = resolve;
        failed = reject;
      }),
      finished: new Promise((resolve) => {
        finished = resolve;
      }),
      dispose,
      fail: () => {
        if (["expired", "error", "connected"].includes(attempt.status.state)) return;
        attempt.status = {
          ...attempt.status,
          state: "error",
          message: "Claude could not complete sign-in. Try again.",
        };
        dispose();
        child.kill("SIGTERM");
        failed(new ActionError(attempt.status.message!));
        finished();
      },
    };
    current = attempt;
    expiry = setTimeout(() => {
      attempt.status = { ...attempt.status, state: "expired", message: "Claude sign-in expired. Try again." };
      dispose();
      child.kill("SIGTERM");
      failed(new ActionError(attempt.status.message!));
      finished();
    }, 10 * 60_000);
    startup = setTimeout(attempt.fail, 10_000);
    let outputSize = 0;
    const captureOutput = (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > 64 * 1024) attempt.fail();
    };
    child.stdout.on("data", captureOutput);
    child.stderr.on("data", captureOutput);
    child.on("error", attempt.fail);
    child.stdin.on("error", attempt.fail);
    polling = setInterval(async () => {
      if (attempt.status.url || attempt.status.state !== "waiting") return;
      try {
        const raw = await readFile(captured, "utf8");
        if (raw.length > 16 * 1024) {
          attempt.fail();
          return;
        }
        const url = new URL(raw);
        const callback = new URL(url.searchParams.get("redirect_uri")!);
        if (
          url.protocol !== "https:" ||
          !["claude.com", "claude.ai"].includes(url.hostname) ||
          url.username ||
          url.password ||
          url.port ||
          callback.protocol !== "http:" ||
          !["localhost", "127.0.0.1"].includes(callback.hostname) ||
          !callback.port ||
          callback.pathname !== "/callback" ||
          callback.username ||
          callback.password ||
          callback.search ||
          callback.hash ||
          !url.searchParams.get("state") ||
          !url.searchParams.get("code_challenge")
        ) {
          attempt.fail();
          return;
        }
        if (attempt.status.state !== "waiting") return;
        callback.hostname = "127.0.0.1";
        attempt.callbackUrl = callback;
        attempt.state = url.searchParams.get("state")!;
        attempt.status = { ...attempt.status, url: url.href };
        clearInterval(polling);
        clearTimeout(startup);
        ready();
      } catch {
        /* The browser launcher has not finished writing the URL yet. */
      }
    }, 50);
    child.on("close", async (code) => {
      if (["expired", "error"].includes(attempt.status.state)) return;
      if (code !== 0) {
        attempt.fail();
        return;
      }
      try {
        if (!(await readClaudeAuthStatus(bin)).loggedIn) {
          attempt.fail();
          return;
        }
        if (["expired", "error"].includes(attempt.status.state)) return;
        attempt.status = { ...attempt.status, state: "connected", message: "Claude Code is signed in on your Mac." };
        dispose();
        ready();
        finished();
      } catch {
        attempt.fail();
      }
    });
    await attempt.ready;
    return attempt.status;
  }
  return {
    start: () => {
      if (starting) return starting;
      starting = start().finally(() => {
        starting = undefined;
      });
      return starting;
    },
    read: (id: string): ClaudeSignIn => read(id).status,
    callback: async (id: string, code: string, state: string): Promise<ClaudeSignIn> => {
      const attempt = read(id);
      if (!state || state !== attempt.state)
        throw new ActionError("This Claude callback does not match the sign-in. Try again.");
      if (attempt.status.state !== "waiting") return attempt.status;
      if (!/^\S{1,4096}$/.test(code) || !attempt.callbackUrl)
        throw new ActionError("Claude returned an invalid sign-in callback. Try again.");
      attempt.status = { ...attempt.status, state: "verifying" };
      const callback = new URL(attempt.callbackUrl);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", state);
      try {
        const response = await fetch(callback, { redirect: "manual", signal: AbortSignal.timeout(35_000) });
        await response.body?.cancel();
        if (response.status < 200 || response.status >= 400) {
          attempt.fail();
          return attempt.status;
        }
        await Promise.race([
          attempt.finished,
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 10_000);
            attempt.finished.finally(() => clearTimeout(timer));
          }),
        ]);
        if (attempt.status.state === "verifying") attempt.fail();
        return attempt.status;
      } catch {
        attempt.fail();
        return attempt.status;
      }
    },
    close: () => {
      current?.fail();
      current?.dispose();
    },
  };
}
