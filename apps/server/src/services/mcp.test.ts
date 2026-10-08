import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, SdkError, SdkErrorCode, SdkHttpError, UnauthorizedError } from "@modelcontextprotocol/client";
import { Effect, Logger } from "effect";
import { ServerConfig } from "@/config";
import { Store } from "./store";
import { connectionState } from "@/lib/presenters";
import { Mcp, clientPool, healthCurrent, isConnectionError } from "./mcp";

const closed = new SdkError(SdkErrorCode.ConnectionClosed, "Connection closed");
const http = (status: number) => new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "Error POSTing", { status });

test("live connection probes replace healthy status on lost login or network failure and recover without cached data", async () => {
  for (const error of [new UnauthorizedError("expired login"), new TypeError("fetch failed")]) {
    await Effect.runPromise(
      Effect.gen(function* () {
        let failed = false;
        const service = yield* Mcp.make({
          hasTokens: async () => true,
          accessToken: async () => "saved-token",
          finishAuth: async () => {},
          connect: async () => {
            const client = new Client({ name: "test", version: "1" });
            client.listTools = async () => {
              if (failed) throw error;
              return { tools: [] };
            };
            return { client };
          },
        });
        yield* service.probe("notion");
        assert.equal(connectionState("notion", true, yield* service.health("notion")).state, "connected");
        failed = true;
        yield* service.probe("notion");
        assert.equal(
          connectionState("notion", true, yield* service.health("notion")).state,
          error instanceof UnauthorizedError ? "not-connected" : "error",
        );
        failed = false;
        yield* service.probe("notion");
        assert.equal(connectionState("notion", true, yield* service.health("notion")).state, "connected");
      }).pipe(Effect.scoped, Effect.provide([Store.layerMemory, ServerConfig.layer, Logger.layer([])])),
    );
  }
});

test("a successful connectivity probe does not hide a failed data tool until that tool succeeds", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let failed = true;
      let probeFailed = false;
      const service = yield* Mcp.make({
        hasTokens: async () => true,
        accessToken: async () => "saved-token",
        finishAuth: async () => {},
        connect: async () => {
          const client = new Client({ name: "test", version: "1" });
          client.listTools = async () => {
            if (probeFailed) throw new TypeError("fetch failed");
            return { tools: [] };
          };
          client.callTool = async () => ({
            content: [{ type: "text", text: failed ? "Missing permission" : "Data" }],
            isError: failed,
          });
          return { client };
        },
      });
      assert.equal((yield* service.call("notion", "search", {}).pipe(Effect.result))._tag, "Failure");
      yield* service.probe("notion");
      assert.equal(connectionState("notion", true, yield* service.health("notion")).state, "error");
      probeFailed = true;
      yield* service.probe("notion");
      probeFailed = false;
      yield* service.probe("notion");
      assert.equal(connectionState("notion", true, yield* service.health("notion")).state, "error");
      failed = false;
      yield* service.call("notion", "search", {});
      assert.equal(connectionState("notion", true, yield* service.health("notion")).state, "connected");
    }).pipe(Effect.scoped, Effect.provide([Store.layerMemory, ServerConfig.layer, Logger.layer([])])),
  );
});

test("isConnectionError: a gone connection or session, not a rate limit or a bad call", () => {
  assert.equal(isConnectionError(closed), true);
  assert.equal(isConnectionError(http(404)), true);
  assert.equal(isConnectionError(http(401)), true);
  assert.equal(isConnectionError(new TypeError("fetch failed", { cause: new Error("other side closed") })), true);
  assert.equal(
    isConnectionError(Object.assign(new TypeError("Unable to connect"), { code: "ConnectionRefused" })),
    true,
  );

  assert.equal(isConnectionError(http(429)), false);
  assert.equal(isConnectionError(http(400)), false);
  assert.equal(isConnectionError(new SdkError(SdkErrorCode.RequestTimeout, "timed out")), false);
  assert.equal(isConnectionError(new Error("Invalid arguments")), false);
});

/** Fake clients: each call fails with the next of `failures`, then succeeds. */
const fakePool = (failures: unknown[]) => {
  const made: { id: number; closed: boolean }[] = [];
  const pool = clientPool(async () => {
    const client = { id: made.length, closed: false, close: async () => void (client.closed = true) };
    made.push(client);
    return client;
  });
  const call = () =>
    pool.use("notion", async (client) => {
      const failure = failures.shift();
      if (failure) throw failure;
      return client.id;
    });
  return { made, call };
};

test("a connection error drops the shared client and retries once on a new one", async () => {
  const { made, call } = fakePool([closed]);
  assert.equal(await call(), 1);
  assert.deepEqual(
    made.map((c) => c.closed),
    [true, false],
  );
});

test("any other error fails the call and keeps the shared client", async () => {
  const bad = new Error("Invalid arguments");
  const { made, call } = fakePool([bad, http(429)]);
  await assert.rejects(call(), bad);
  await assert.rejects(call(), (error) => error instanceof SdkHttpError && error.status === 429);
  assert.equal(await call(), 0);
  assert.equal(made.length, 1);
  assert.equal(made[0]?.closed, false);
});

test("a second connection error is not retried again", async () => {
  const { made, call } = fakePool([closed, closed]);
  await assert.rejects(call(), closed);
  assert.equal(made.length, 2);
});

test("a working connection's health is rewritten after 5 minutes, and a change of state at once", () => {
  const at = "2026-09-28T10:00:00.000Z";
  const now = (minutes: number) => Date.parse(at) + minutes * 60_000;
  assert.equal(healthCurrent({ ok: true, at }, true, now(4)), true);
  assert.equal(healthCurrent({ ok: true, at }, true, now(6)), false);
  assert.equal(healthCurrent({ ok: true, at }, false, now(1)), false);
  assert.equal(healthCurrent({ ok: false, at }, true, now(1)), false);
});
