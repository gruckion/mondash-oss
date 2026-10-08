import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Prefer the desktop app's CLI, then a standalone installation or PATH. */
export const codexExecutable = () =>
  [
    "/Applications/Codex.app/Contents/Resources/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    join(homedir(), ".local/bin/codex"),
  ].find((path) => existsSync(path)) ?? "codex";
