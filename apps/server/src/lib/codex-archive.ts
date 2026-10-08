import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { Option, Schema } from "effect";
import { codexExecutable } from "./codex-cli";
import { ActionError } from "./action-error";

const decodeResponse = Schema.decodeUnknownOption(
  Schema.Struct({
    id: Schema.Int,
    result: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Struct({ message: Schema.String })),
  }),
);

/** Uses the installed Codex app-server protocol: Codex performs the native archive transition itself. */
export function archiveCodexSession(sessionId: string, archived: boolean, signal?: AbortSignal): Promise<void> {
  const executable = codexExecutable();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["app-server"], { cwd: homedir(), stdio: ["pipe", "pipe", "ignore"] });
    const lines = createInterface({ input: child.stdout });
    let finished = false;
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      lines.close();
      child.stdin.end();
      child.kill();
      if (error) reject(error);
      else resolve();
    };
    const abort = () =>
      finish(new ActionError("The archive request was cancelled. Refresh to check its native state."));
    const timeout = setTimeout(
      () => finish(new ActionError("Codex did not confirm the archive change. Try again.")),
      20_000,
    );
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.on("error", () => finish(new ActionError("Could not start Codex on your Mac. Check that it is installed.")));
    child.on("exit", () => finish(new ActionError("Codex closed before confirming the archive change.")));
    child.stdin.on("error", () => finish(new ActionError("Could not send the archive request to Codex.")));
    lines.on("line", (line) => {
      let decoded;
      try {
        decoded = decodeResponse(JSON.parse(line));
      } catch {
        return;
      }
      if (Option.isNone(decoded)) return;
      const message = decoded.value;
      if (message.id !== 1 && message.id !== 2) return;
      if (message.error)
        return finish(
          new ActionError("Codex could not change this session’s archive state. It may still be running.", {
            cause: new Error(String(message.error.message)),
          }),
        );
      if (!("result" in message)) return;
      if (message.id === 1) {
        send({ method: "initialized", params: {} });
        send({ id: 2, method: archived ? "thread/archive" : "thread/unarchive", params: { threadId: sessionId } });
      } else finish();
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) return abort();
    send({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "mondash", title: "Mondash", version: "1.0.0" } },
    });
  });
}
