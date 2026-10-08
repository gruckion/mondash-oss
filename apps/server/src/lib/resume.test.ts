import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Layer, Logger } from "effect";
import { Mcp, McpFailure } from "@/services/mcp";
import { SlackApi, SlackFailure } from "@/services/slack";
import { Store } from "@/services/store";
import { type ActiveTicket, compareIssueTickets, findUnlinkedThreads } from "./resume";

const unused = Effect.die(new Error("not called in this test"));
const at = new Date("2026-09-24T12:00:00.000Z");
const ticket = (id: string): ActiveTicket => ({
  id,
  title: id,
  url: `https://linear.app/example/issue/${id}`,
  status: "Started",
  statusType: "started",
  priority: { value: 2, name: "High" },
  attachments: [],
  updatedAt: at.toISOString(),
  prs: [],
  otherPRs: [],
  sessions: [],
  slack: [],
  notion: [],
  reply: null,
  assigned: { at },
});

test("equal-priority issues put started work ahead of Todo, then retain blocker ordering", () => {
  const todo = { ...ticket("DEMO-3973"), status: "Todo", statusType: "unstarted", labels: ["Launch Blocker"] };
  const started = ticket("DEMO-4174");
  const urgent = { ...todo, id: "urgent", priority: { value: 1, name: "Urgent" } };
  const startedBlocker = { ...started, id: "started-blocker", labels: ["Launch Blocker"] };
  assert.deepEqual(
    [todo, started, urgent, startedBlocker].sort(compareIssueTickets).map((t) => t.id),
    ["urgent", "started-blocker", "DEMO-4174", "DEMO-3973"],
  );
});

test("recent session activity only breaks ties after priority and status", () => {
  const withSession = (issue: ActiveTicket, updatedAt: Date): ActiveTicket => ({
    ...issue,
    sessions: [
      {
        tool: "claude",
        id: issue.id,
        title: issue.id,
        firstPrompt: "",
        lastPrompt: "",
        cwd: "/tmp",
        refs: {},
        promptRefs: {},
        updatedAt,
        jev: 0.9,
        associationVersion: 2,
      },
    ],
  });
  const todo = withSession(
    { ...ticket("DEMO-3973"), status: "Todo", statusType: "unstarted" },
    new Date(at.getTime() + 60_000),
  );
  const started = withSession(ticket("DEMO-4174"), at);
  const recentStarted = withSession(ticket("DEMO-2561"), new Date(at.getTime() + 30_000));
  assert.deepEqual(
    [todo, started, recentStarted].sort(compareIssueTickets).map((t) => t.id),
    ["DEMO-2561", "DEMO-4174", "DEMO-3973"],
  );
});

const searchHit = (id: string) => `# Search Results for: ${id}

## Messages (1 results)
### Result 1 of 1
Channel: #eng (ID: C123)
From: Avery Brooks <avery@example.com> (ID: U1)
Time: 2026-09-18 17:07:17 BST
Message_ts: 1789747637.478879
Permalink: [link](https://x.slack.com/archives/C123/p1789747637478879)
Text:
Can someone look at ${id}?

---
`;

test("one ticket's failed Slack search leaves the other tickets' threads", async () => {
  const mcp = Mcp.of({
    signIn: () => unused,
    finishSignIn: () => unused,
    call: () => unused,
    cachedCall: (server, tool, args) => {
      if (tool === "slack_read_thread") return Effect.fail(new McpFailure({ server, cause: "no thread" }));
      return args.query === "DEMO-1"
        ? Effect.fail(new McpFailure({ server, cause: "ratelimited" }))
        : Effect.succeed(JSON.stringify({ results: searchHit(String(args.query)) }));
    },
    accessToken: () => unused,
    hasTokens: () => unused,
    health: () => unused,
    probe: () => unused,
  });
  const slack = SlackApi.of({
    get: (method) => Effect.fail(new SlackFailure({ method, error: "not_faked" })),
    post: (method) => Effect.fail(new SlackFailure({ method, error: "not_faked" })),
  });

  const found = await findUnlinkedThreads([ticket("DEMO-1"), ticket("DEMO-2")]).pipe(
    Effect.scoped,
    Effect.provide([Store.layerMemory, Layer.succeed(SlackApi, slack), Logger.layer([])]),
    Effect.provideService(Mcp, mcp),
    Effect.runPromise,
  );

  assert.deepEqual([...found.keys()], ["DEMO-2"]);
  assert.equal(found.get("DEMO-2")?.[0]?.text, "Can someone look at DEMO-2?");
});
