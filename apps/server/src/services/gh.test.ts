import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Result, Schema } from "effect";
import { GITHUB_HEALTH_KEY, makeGh } from "./gh";
import { Store } from "./store";

test("a failed GitHub login replaces previously healthy status; successful reads restore it", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.write(GITHUB_HEALTH_KEY, { ok: true, at: "2026-09-29T06:34:42.822Z" });
      let failing = true;
      const gh = yield* makeGh(async () => {
        if (failing) throw new Error("GitHub login was revoked");
        return { stdout: JSON.stringify({ login: "me" }) };
      });
      const schema = Schema.Struct({ login: Schema.String });
      const failed = yield* gh.json(["api", "user"], schema).pipe(Effect.result);
      assert.ok(Result.isFailure(failed));
      assert.equal((yield* store.read(GITHUB_HEALTH_KEY))?.value.ok, false);
      failing = false;
      assert.equal((yield* gh.json(["api", "user"], schema)).login, "me");
      assert.equal((yield* store.read(GITHUB_HEALTH_KEY))?.value.ok, true);
    }).pipe(Effect.provide(Store.layerMemory)),
  );
});

test("GraphQL quota exhaustion survives client recreation and leaves REST available", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let calls = 0;
      const reset = Math.ceil(Date.now() / 1000) + 3600;
      const execute = async (args: ReadonlyArray<string>) => {
        calls++;
        if (args[1] === "graphql")
          throw Object.assign(new Error("quota"), {
            stderr: "gh: API rate limit already exceeded",
            stdout: `HTTP/2.0 200 OK\r\nX-RateLimit-Resource: graphql\r\nX-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: ${reset}\r\n\r\n{"errors":[{"type":"RATE_LIMIT"}]}`,
          });
        return { stdout: '{"login":"me"}' };
      };
      const schema = Schema.Struct({ login: Schema.String });
      const first = yield* makeGh(execute);
      yield* first.json(["api", "graphql", "-f", "query={viewer{login}}"], schema).pipe(Effect.result);
      const recreated = yield* makeGh(execute);
      assert.ok(
        Result.isFailure(
          yield* recreated.json(["api", "graphql", "-f", "query={viewer{login}}"], schema).pipe(Effect.result),
        ),
      );
      assert.equal(calls, 1, "no subprocess is launched before GitHub's reset");
      assert.equal((yield* recreated.json(["api", "user"], schema)).login, "me");
      assert.equal(calls, 2);
    }).pipe(Effect.provide(Store.layerMemory)),
  );
});

test("GraphQL gateway timeouts are not multiplied into four expensive attempts", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let calls = 0;
      const gh = yield* makeGh(async () => {
        calls++;
        throw Object.assign(new Error("gateway"), { stderr: "HTTP 504: Gateway Timeout" });
      });
      yield* gh.json(["api", "graphql", "-f", "query={viewer{login}}"], Schema.Unknown).pipe(Effect.result);
      assert.equal(calls, 1);
    }).pipe(Effect.provide(Store.layerMemory)),
  );
});

test("included REST headers preserve paginated slurp JSON and GraphQL queries request their cost", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const gh = yield* makeGh(async (args) => {
        assert.ok(args.includes("--include"));
        if (args[1] === "graphql") {
          assert.match(args.join(" "), /rateLimit\s*\{/);
          return {
            stdout:
              'HTTP/2.0 200 OK\nX-RateLimit-Resource: graphql\nX-RateLimit-Remaining: 4000\n\n{"data":{"viewer":{"login":"me"},"rateLimit":{"cost":1,"remaining":4000,"used":1000,"limit":5000,"resetAt":"2030-01-01T00:00:00Z"}}}',
          };
        }
        return {
          stdout:
            '[HTTP/2.0 200 OK\nX-RateLimit-Resource: core\nX-RateLimit-Remaining: 4999\n\n[{"id":1}],HTTP/2.0 200 OK\nX-RateLimit-Resource: core\nX-RateLimit-Remaining: 4998\n\n[{"id":2}]]',
        };
      });
      const pages = yield* gh.json(
        ["api", "items", "--paginate", "--slurp"],
        Schema.Array(Schema.Array(Schema.Struct({ id: Schema.Finite }))),
      );
      assert.deepEqual(pages, [[{ id: 1 }], [{ id: 2 }]]);
      assert.equal(
        (yield* gh.json(
          ["api", "graphql", "-f", "query={viewer{login}}"],
          Schema.Struct({ data: Schema.Record(Schema.String, Schema.Struct({ login: Schema.String })) }),
        )).data.viewer.login,
        "me",
      );
    }).pipe(Effect.provide(Store.layerMemory)),
  );
});

test("the reserved GraphQL allowance pauses until reset, then automatically resumes", async () => {
  const { TestClock } = await import("effect/testing");
  await Effect.runPromise(
    Effect.gen(function* () {
      let calls = 0;
      const gh = yield* makeGh(async () => {
        calls++;
        return {
          stdout: `HTTP/2.0 200 OK\nX-RateLimit-Resource: graphql\nX-RateLimit-Remaining: ${calls === 1 ? 500 : 4999}\nX-RateLimit-Reset: 60\n\n{"data":{"viewer":{"login":"me"}}}`,
        };
      });
      const args = ["api", "graphql", "-f", "query={viewer{login}}"];
      const schema = Schema.Struct({ data: Schema.Struct({ viewer: Schema.Struct({ login: Schema.String }) }) });
      yield* gh.json(args, schema);
      assert.ok(Result.isFailure(yield* gh.json(args, schema).pipe(Effect.result)));
      assert.equal(calls, 1);
      yield* TestClock.adjust("62 seconds");
      assert.equal((yield* gh.json(args, schema)).data.viewer.login, "me");
      assert.equal(calls, 2);
    }).pipe(Effect.provide([Store.layerMemory, TestClock.layer()])),
  );
});
