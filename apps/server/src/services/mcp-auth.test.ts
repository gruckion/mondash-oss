import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { Effect, Logger, Schema } from "effect";
import { ServerConfig } from "@/config";
import { Health, Mcp, McpFailure } from "./mcp";
import { Store, storeKey } from "./store";

for (const mode of ["callback", "already-connected"] as const) {
  test(`${mode}: successful Notion sign-in clears failed health and retry delays without losing snapshots`, async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        const service = yield* Mcp.make({
          connect: async () => ({ client: new Client({ name: "test", version: "1" }) }),
          finishAuth: async () => {},
          hasTokens: async () => true,
          accessToken: async () => "test-token",
        });
        const roadmap = storeKey("roadmap:v9", Schema.String);
        const comments = storeKey("mcp:notion:notion-get-comments:{}", Schema.String);
        const slack = storeKey("mcp:slack:slack_read_thread:{}", Schema.String);
        for (const key of [roadmap, comments, slack]) {
          yield* store.write(key, "saved snapshot");
          yield* store
            .refresh(key, Effect.fail(new McpFailure({ server: "notion", cause: "signed out" })))
            .pipe(Effect.result);
        }
        yield* store.write(storeKey("health:notion", Health), {
          ok: false,
          at: "2026-09-30T12:16:12.923Z",
          message: "notion is not connected",
        });
        if (mode === "callback") yield* service.finishSignIn("notion", new URLSearchParams("code=test&state=test"));
        else yield* service.signIn("notion", `http://localhost:${(yield* ServerConfig).port}`);

        assert.equal((yield* service.health("notion"))?.ok, true, "successful sign-in must stop showing Failed");
        for (const key of [roadmap, comments]) {
          assert.equal((yield* store.read(key))?.value, "saved snapshot", "keep the old copy until fresh data arrives");
          assert.equal(
            yield* store.refresh(key, Effect.succeed("fresh snapshot")),
            "fresh snapshot",
            "retry immediately after authentication",
          );
        }
        assert.equal(
          yield* store.refresh(slack, Effect.succeed("new")),
          "saved snapshot",
          "leave other providers' backoff alone",
        );
      }).pipe(Effect.scoped, Effect.provide([Store.layerMemory, ServerConfig.layer, Logger.layer([])])),
    );
  });
}

test("OAuth completion replaces the pooled Notion client with one using the new login", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let login = "old login";
      const service = yield* Mcp.make({
        connect: async () => {
          const account = login;
          const client = new Client({ name: "test", version: "1" });
          client.callTool = async () => ({ content: [{ type: "text", text: account }] });
          return { client };
        },
        finishAuth: async () => {
          login = "new login";
        },
        hasTokens: async () => true,
        accessToken: async () => "test-token",
      });
      assert.equal(yield* service.call("notion", "notion-get-users", {}), "old login");
      yield* service.finishSignIn("notion", new URLSearchParams("code=test&state=test"));
      assert.equal(yield* service.call("notion", "notion-get-users", {}), "new login");
    }).pipe(Effect.scoped, Effect.provide([Store.layerMemory, ServerConfig.layer, Logger.layer([])])),
  );
});
