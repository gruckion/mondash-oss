import { enabled } from "../profile";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Context, DateTime, Effect, Layer } from "effect";
import type { ClaudeSignIn, Connection } from "@mondash/shared/contract";
import { ServerConfig } from "@/config";
import { claudeExecutable, readClaudeAuthStatus } from "@/lib/claude-cli";
import { createClaudeSignIn } from "@/lib/claude-sign-in";
import { codexExecutable } from "@/lib/codex-cli";
import { codexReadiness } from "@/lib/codex-remote-host";
import { ActionFailure, toActionFailure } from "./errors";

const run = promisify(execFile);

/** CLI login and desktop readiness are checked independently of local transcript indexing. */
export class AgentAuth extends Context.Service<
  AgentAuth,
  {
    health: Effect.Effect<readonly Connection[]>;
    startClaude: Effect.Effect<ClaudeSignIn, ActionFailure>;
    readClaude(id: string): Effect.Effect<ClaudeSignIn, ActionFailure>;
    callbackClaude(id: string, code: string, state: string): Effect.Effect<ClaudeSignIn, ActionFailure>;
  }
>()("mondash/server/AgentAuth") {
  static readonly layer = Layer.effect(
    AgentAuth,
    Effect.gen(function* () {
      const { claudeBin } = yield* ServerConfig;
      const executable = () => claudeExecutable(claudeBin);
      const signIn = yield* Effect.acquireRelease(
        Effect.sync(() => createClaudeSignIn(executable)),
        (opened) => Effect.sync(() => opened.close()),
      );
      const attempt = <A>(action: string, work: () => Promise<A>) =>
        Effect.tryPromise({
          try: work,
          catch: toActionFailure(action, "Could not complete Claude sign-in. Try again."),
        });
      const check = (name: "claude" | "codex", work: () => Promise<Omit<Connection, "name" | "checkedAt">>) =>
        Effect.tryPromise(work).pipe(
          Effect.catch(() =>
            Effect.succeed({
              state: "error" as const,
              message: `Could not check ${name === "claude" ? "Claude Code" : "Codex"} on your Mac. Try again.`,
            }),
          ),
          Effect.flatMap((connection) =>
            DateTime.now.pipe(
              Effect.map((at): Connection => ({ ...connection, name, checkedAt: DateTime.formatIso(at) })),
            ),
          ),
        );
      return AgentAuth.of({
        startClaude: attempt("startClaudeSignIn", () => signIn.start()),
        readClaude: (id) => attempt("readClaudeSignIn", async () => signIn.read(id)),
        callbackClaude: (id, code, state) => attempt("callbackClaudeSignIn", () => signIn.callback(id, code, state)),
        health: enabled("sessions")
          ? Effect.all(
              [
                check("claude", async () => {
                  const auth = await readClaudeAuthStatus(await executable());
                  return auth.loggedIn
                    ? {
                        state: "connected",
                        message: "Signed in on your Mac. Session connectivity is checked when opening a session.",
                      }
                    : { state: "not-connected", message: "Claude Code is no longer logged in on your Mac." };
                }),
                check("codex", async () => {
                  const bin = codexExecutable();
                  let loggedIn = false;
                  try {
                    const result = await run(bin, ["login", "status"], { timeout: 8_000, maxBuffer: 64 * 1024 });
                    loggedIn = /Logged in using (ChatGPT|an API key)/i.test(`${result.stdout}\n${result.stderr}`);
                    if (!loggedIn) throw new Error("Unrecognized Codex login status");
                  } catch (error) {
                    if (
                      !(error instanceof Error) ||
                      !("stderr" in error) ||
                      !/Not logged in/i.test(String(error.stderr))
                    )
                      throw error;
                  }
                  if (!loggedIn) return { state: "not-connected", message: "Codex is not logged in on your Mac." };
                  const readiness = await codexReadiness();
                  return !readiness.registered
                    ? {
                        state: "error",
                        message: "Codex is signed in, but remote access is not registered in the desktop app.",
                      }
                    : !readiness.running
                      ? {
                          state: "error",
                          message: "Codex is signed in, but the ChatGPT desktop app is not running on your Mac.",
                        }
                      : {
                          state: "connected",
                          message:
                            "Signed in; desktop app running; remote access registered. This does not verify a live phone connection.",
                        };
                }),
              ],
              { concurrency: "unbounded" },
            )
          : Effect.succeed([]),
      });
    }),
  );
}
