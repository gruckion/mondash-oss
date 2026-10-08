import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createCodexRemoteOpener, hasCodexRegistration, type CodexRemoteDependencies } from "./codex-remote";

const run = promisify(execFile);
export const isCodexAppServer = (line: string) =>
  /\/(?:ChatGPT|Codex)\.app\/Contents\/Resources\/(?:codex|codex-cli\/CodexCLI\.app\/Contents\/MacOS\/codex)\s.*\bapp-server\b/.test(
    line,
  );
const registered = async () => {
  try {
    return hasCodexRegistration(
      JSON.parse(await readFile(join(homedir(), ".codex", ".codex-global-state.json"), "utf8")),
    );
  } catch {
    return false;
  }
};
const running = async () => {
  const { stdout } = await run("/bin/ps", ["-axo", "comm=,args="], { timeout: 3_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.split("\n").some(isCodexAppServer);
};
export const codexReadiness = async () => {
  const [isRegistered, isRunning] = await Promise.all([registered(), running()]);
  return { registered: isRegistered, running: isRunning };
};
/** The Codex handoff on this Mac. `find` looks up the local session; the Sessions service supplies it. */
export const codexHost = (find: CodexRemoteDependencies["find"]) =>
  createCodexRemoteOpener({
    find,
    registered,
    running,
  });
