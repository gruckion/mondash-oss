import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Option, Schema } from "effect";
import { ActionError } from "./action-error";

const run = promisify(execFile);
const decodeAuthStatus = Schema.decodeUnknownSync(
  Schema.Struct({ loggedIn: Schema.Boolean, authMethod: Schema.optional(Schema.String) }),
);
const authCommandFailure = Schema.decodeUnknownOption(
  Schema.Struct({ code: Schema.Literal(1), stdout: Schema.String }),
);

export class ClaudeSignedOut extends ActionError {
  constructor() {
    super("Claude Code is no longer logged in on your Mac.");
  }
}

export async function claudeExecutable(claudeBin: Option.Option<string>) {
  if (Option.isSome(claudeBin)) return claudeBin.value;
  const installed = join(homedir(), ".local/bin/claude");
  return await access(installed).then(
    () => installed,
    () => "claude",
  );
}

/** The installed CLI owns credentials; signed-out status is JSON even when it exits with status 1. */
export async function readClaudeAuthStatus(executable: string) {
  try {
    const { stdout } = await run(executable, ["auth", "status"], { timeout: 8_000, maxBuffer: 64 * 1024 }).catch(
      (cause: unknown) => {
        const failed = authCommandFailure(cause);
        if (Option.isNone(failed)) throw cause;
        return { stdout: failed.value.stdout };
      },
    );
    return decodeAuthStatus(JSON.parse(stdout));
  } catch (cause) {
    throw new ActionError("Could not check whether Claude Code is logged in on your Mac. Try again.", { cause });
  }
}

export async function ensureClaudeAuthenticated(executable: string) {
  if (!(await readClaudeAuthStatus(executable)).loggedIn) throw new ClaudeSignedOut();
}
