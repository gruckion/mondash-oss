import assert from "node:assert/strict";
import { test } from "node:test";
import { Cause, Effect, Exit, Option } from "effect";
import { FetchHttpClient } from "effect/http";
import { describe, isTimeout, makeClient } from "./api";

/** What the app would say if the Mac answered a Mark read with this response, or did not answer at all. */
async function messageFor(respond?: () => Response, id = "x"): Promise<string> {
  let requests = 0;
  const server = respond
    ? Bun.serve({
        port: 0,
        fetch: () => {
          requests++;
          return respond();
        },
      })
    : undefined;
  const baseUrl = server ? `http://127.0.0.1:${server.port}` : "http://127.0.0.1:9";
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const client = yield* makeClient(baseUrl);
      return yield* client.actions.markRead({ payload: { id, read: true } });
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
  void server?.stop();
  assert.ok(Exit.isFailure(exit));
  if (id === "") assert.equal(requests, 0);
  const failure = Cause.findErrorOption(exit.cause);
  return describe(Option.isSome(failure) ? failure.value : Cause.squash(exit.cause), "action");
}

test("only a Mac that never answers asks to check the Mac connection", async () => {
  assert.match(await messageFor(), /Mondash on your Mac/);
  assert.match(await messageFor(() => new Response("boom", { status: 500 })), /hit an error \(HTTP 500\)/);
  assert.match(await messageFor(() => Response.json({}, { status: 400 })), /refused the request \(HTTP 400\)/);
  assert.match(await messageFor(() => Response.json({ nope: true })), /incompatible response/);
});

test("a declared failure shows the Mac's own words", async () => {
  const message = "Session not found in the last 7 days";
  assert.equal(await messageFor(() => Response.json({ _tag: "ActionFailed", message }, { status: 422 })), message);
});

test("an input the phone cannot encode is not blamed on the Mac", async () => {
  const message = await messageFor(() => Response.json({}), "");
  assert.match(message, /not sent/);
  assert.doesNotMatch(message, /incompatible|Update Mondash/);
});

test("a timeout asks to pull only when loading", () => {
  const timeout = new Cause.TimeoutError();
  assert.match(describe(timeout, "load"), /Pull to try again/);
  assert.doesNotMatch(describe(timeout, "action"), /Pull/);
  assert.ok(isTimeout(new Error("late", { cause: timeout })));
  assert.equal(isTimeout(new Error("other", { cause: new Error("x") })), false);
});
