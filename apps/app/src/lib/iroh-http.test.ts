import assert from "node:assert/strict";
import { createConnection, type Socket } from "node:net";
import { once } from "node:events";
import { test } from "node:test";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { ActionFailed } from "@mondash/shared/api";
import { makeClient } from "./api";
import { createIrohFetch, type IrohBridge } from "./iroh-http";

/** The independent HTTP server supplies wire bytes; this replaces only the platform's encrypted byte pipe. */
function tcpBridge(port: number): IrohBridge & { active: Map<string, Socket> } {
  const active = new Map<string, Socket>();
  return {
    active,
    async open(id, _ticket, bytes) {
      const socket = createConnection({ host: "127.0.0.1", port });
      active.set(id, socket);
      socket.on("error", () => {});
      await once(socket, "connect");
      socket.write(bytes);
    },
    async read(id, limit) {
      const socket = active.get(id);
      if (!socket) throw new Error("Closed request");
      while (!socket.readableLength) {
        if (socket.destroyed) throw new Error("Connection closed");
        if (socket.readableEnded) return new Uint8Array();
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            socket.off("readable", ready);
            socket.off("end", ready);
            socket.off("error", failed);
            socket.off("close", closed);
          };
          const ready = () => {
            cleanup();
            resolve();
          };
          const failed = (error: Error) => {
            cleanup();
            reject(error);
          };
          const closed = () => {
            cleanup();
            reject(new Error("Connection closed"));
          };
          socket.once("readable", ready);
          socket.once("end", ready);
          socket.once("error", failed);
          socket.once("close", closed);
        });
      }
      // Deliberately split status/header/chunk lines and UTF-8 sequences across reads.
      return new Uint8Array(socket.read(Math.min(limit, socket.readableLength, 7)) as Uint8Array);
    },
    async cancel(id) {
      const socket = active.get(id);
      active.delete(id);
      socket?.destroy();
    },
  };
}

test("Iroh wire preserves UTF-8 POST bytes and the generated client's typed action error", async () => {
  let received: unknown;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      received = await request.json();
      return Response.json(
        { _tag: "ActionFailed", message: "fixture refused 🦋" },
        { status: 422, headers: { "x-fixture": "independent" } },
      );
    },
  });
  const bridge = tcpBridge(server.port!);
  const wire = createIrohFetch(bridge, "fixture", "https://paired.iroh");
  try {
    const program = Effect.gen(function* () {
      const client = yield* makeClient("https://paired.iroh");
      return yield* client.actions.markRead({ payload: { id: "café 🦋", read: true } });
    }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, wire as typeof fetch));
    await assert.rejects(
      Effect.runPromise(program),
      (error: unknown) => error instanceof ActionFailed && error.message === "fixture refused 🦋",
    );
    assert.deepEqual(received, { id: "café 🦋", read: true });
    assert.equal(bridge.active.size, 0);
  } finally {
    server.stop(true);
  }
});

test("Cancelling a live stream leaves simultaneous JSON requests intact", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/api/stream")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: 🦋\n\n"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      return Response.json({ value: "another request 🦋" }, { headers: { "x-fixture": "independent" } });
    },
  });
  const bridge = tcpBridge(server.port!);
  const wire = createIrohFetch(bridge, "fixture", "https://paired.iroh");
  const aborter = new AbortController();
  try {
    const stream = await wire("https://paired.iroh/api/stream", { signal: aborter.signal });
    const reader = stream.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), "data: 🦋\n\n");
    const waiting = reader.read();
    const others = Promise.all(
      Array.from({ length: 6 }, async () => {
        const response = await wire("https://paired.iroh/api/health");
        assert.equal(response.headers.get("x-fixture"), "independent");
        return response.json();
      }),
    );
    aborter.abort();
    await assert.rejects(waiting, { name: "AbortError" });
    assert.deepEqual(
      await others,
      Array.from({ length: 6 }, () => ({ value: "another request 🦋" })),
    );
    assert.equal(bridge.active.size, 0);
  } finally {
    await Promise.all([...bridge.active.keys()].map((id) => bridge.cancel(id)));
    server.stop(true);
  }
});
