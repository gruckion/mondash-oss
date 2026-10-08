import assert from "node:assert/strict";
import { test } from "node:test";
import { SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";
import { GhFailure, transientGh } from "./gh";
import { McpFailure, transientMcp } from "./mcp";
import { SlackFailure, transientSlack } from "./slack";

const namedError = (name: string) => Object.assign(new Error("failed"), { name });
const execError = (stderr: string, killed = false) => Object.assign(new Error("gh failed"), { stderr, killed });

test("Slack: rate limits, 5xx, timeouts and network drops are retried; refusals are not", () => {
  const slack = (fields: Partial<{ error: string; cause: unknown }>) =>
    transientSlack(new SlackFailure({ method: "conversations.info", ...fields }));
  assert.equal(slack({ error: "ratelimited" }), true);
  assert.equal(slack({ error: "http 429" }), true);
  assert.equal(slack({ error: "http 503" }), true);
  assert.equal(slack({ cause: namedError("TimeoutError") }), true);
  assert.equal(slack({ cause: new TypeError("fetch failed") }), true);
  assert.equal(slack({ error: "invalid_auth" }), false);
  assert.equal(slack({ error: "http 404" }), false);
  assert.equal(slack({ cause: new Error("Slack is not connected") }), false);
});

test("gh: REST 5xx and network drops retry; GraphQL gateway timeouts and rate limits do not", () => {
  const gh = (cause: unknown) => transientGh(new GhFailure({ command: "api graphql", cause }));
  assert.equal(gh(execError("gh: HTTP 502: Bad Gateway")), false);
  assert.equal(
    transientGh(new GhFailure({ command: "api user", cause: execError("gh: HTTP 502: Bad Gateway") })),
    true,
  );
  assert.equal(gh(execError("read: connection reset by peer")), true);
  assert.equal(gh(execError("gh: API rate limit exceeded")), false);
  assert.equal(gh(execError("", true)), false);
  assert.equal(gh(execError("gh: Field 'x' doesn't exist on type 'PullRequest'")), false);
});

test("MCP: 429 and 5xx are retried; other statuses are not", () => {
  const mcp = (status: number) =>
    transientMcp(
      new McpFailure({
        server: "linear",
        cause: new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "failed", { status }),
      }),
    );
  assert.equal(mcp(429), true);
  assert.equal(mcp(503), true);
  assert.equal(mcp(400), false);
  assert.equal(
    transientMcp(new McpFailure({ server: "linear", cause: new Error("linear.get_issue failed: not found") })),
    false,
  );
});
