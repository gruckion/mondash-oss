import assert from "node:assert/strict";
import { test } from "node:test";
import { Exit, Schema } from "effect";

const decodes = (schema: Schema.ConstraintDecoder<unknown>, value: unknown) =>
  Exit.isSuccess(Schema.decodeUnknownExit(schema)(value));
import { Group, HealthResponse, LinkInput, SectionResponse } from "@mondash/shared/contract";
import {
  connectionState,
  issueGroups,
  prCard,
  reviewGroups,
  scopingGroups,
  sessionView,
  sessionGroups,
  withSessionContext,
  webLink,
} from "./presenters.ts";
import type { AgentSession } from "./sessions.ts";
import type { PullRequest } from "./github.ts";
import type { RoadmapCard } from "./notion.ts";
import type { ReviewItem } from "./github-feed.ts";
import { createReviewScopeResolver } from "./review-scope.ts";
import type { ActiveTicket } from "./resume.ts";

const now = new Date();
const session: AgentSession = {
  id: "FF72D97B-08D1-5D66-B204-0574B0A0BAC6",
  tool: "claude",
  title: "Review billing",
  updatedAt: now,
  cwd: "/Users/example/private",
  firstPrompt: "private first prompt",
  lastPrompt: "private last prompt",
  refs: {},
  promptRefs: {},
  branch: "private-branch",
};
const pr: PullRequest = {
  changes: { additions: 178, deletions: 19, files: 8 },
  repo: "example/app",
  number: 12,
  title: "Fix billing",
  url: "https://github.com/example/app/pull/12",
  createdAt: now,
  updatedAt: now,
  branch: "billing",
  isDraft: false,
  people: [],
  approvedBy: [],
  checksSummary: { passed: 8, failed: 1, pending: 3, skipped: 2 },
  aiCheckFailures: ["Greptile Review"],
  review: "REVIEW_REQUIRED",
  checks: "FAILURE",
  conflicts: true,
  waitingBy: {},
  reply: { from: ["morgan-demo"], count: 1, at: now, url: "https://github.com/example/app/pull/12#discussion" },
  aiThreads: { count: 2, url: "https://github.com/example/app/pull/12#ai" },
};

test("app links undo desktop Linear and Notion links, retaining comment anchors", () => {
  assert.equal(
    webLink("linear://example/issue/DEMO-123?comment=c#reply"),
    "https://linear.app/example/issue/DEMO-123?comment=c#reply",
  );
  assert.equal(
    webLink("notion://www.notion.so/page?d=comment&deepLinkOpenNewTab=true#block"),
    "https://www.notion.so/page?d=comment#block",
  );
  for (const url of [
    "file:///Users/private",
    "codex://session/123",
    "javascript:alert(1)",
    "http://example.com",
    "broken",
  ])
    assert.equal(webLink(url), undefined);
});

test("session payload excludes Mac paths, prompts, branch and raw references", () => {
  const result = sessionView(session);
  assert.deepEqual(
    Object.keys(result).sort(),
    ["canArchive", "canOpenInClaude", "canOpenInChatGPT", "canOpenOnMac", "id", "title", "tool", "updatedAt"].sort(),
  );
  assert.equal(result.updatedAt, now.toISOString());
  assert.equal(result.canOpenOnMac, false);
  assert.equal(result.canOpenInClaude, true);
  assert.equal(result.canOpenInChatGPT, false);
  assert.equal(sessionView({ ...session, tool: "codex" }).canOpenInChatGPT, true);
  assert.equal(sessionView({ ...session, tool: "codex" }).canOpenInClaude, false);
  assert.equal(sessionView({ ...session, updatedAt: new Date(Date.now() - 8 * 86400000) }).canOpenInClaude, true);
  assert.equal(sessionView({ ...session, tool: "codex" }).canOpenOnMac, false);
  assert.equal(sessionView({ ...session, updatedAt: new Date(Date.now() - 8 * 86400000) }).canOpenOnMac, false);
});

test("session previews survive both associated PR sessions and recent-session boundaries", () => {
  const withPreview = {
    ...session,
    preview: "The billing fix is ready to review.",
    previewKind: "recap" as const,
    contextUsage: { usedTokens: 64003, windowTokens: 1000000 },
    linkedPRs: ["pr:example/app#12"],
    refs: { ...session.refs, "pr:example/app#99": 1 },
  };
  assert.deepEqual(
    sessionGroups([withPreview])[0].cards[0].links,
    [{ title: "app#12", url: "https://github.com/example/app/pull/12" }],
    "explicit session associations survive without promoting incidental mentions",
  );
  assert.equal(sessionView(withPreview).preview, withPreview.preview);
  assert.equal(sessionView(withPreview).previewKind, "recap");
  const card = prCard({ ...pr, sessions: [withPreview] });
  assert.equal(card.sessions[0].preview, withPreview.preview);
  assert.equal(card.sessions[0].previewKind, "recap");
  assert.deepEqual(card.sessions[0].contextUsage, withPreview.contextUsage);
  Schema.decodeSync(Group)({ id: "context", title: "Context", collapsed: false, cards: [card] });
  assert.equal(sessionGroups([withPreview])[0].cards[0].sessions[0].preview, withPreview.preview);
  assert.ok(
    decodes(Group, { id: "old", title: "Old", collapsed: false, cards: [prCard({ ...pr, sessions: [session] })] }),
  );
});

test("PR attention preserves replies, conflicts, check failures and AI review links", () => {
  const card = prCard(pr);
  assert.deepEqual(card.attention, [
    "1 reply waiting · Morgan P",
    "Merge conflicts",
    "Checks failing",
    "2 AI review threads",
  ]);
  assert.equal(card.links.length, 2);
  assert.equal(card.prKey, "app#12");
  assert.equal(card.prState, "OPEN");
  assert.deepEqual(card.checksSummary, pr.checksSummary);
  assert.deepEqual(card.aiCheckFailures, pr.aiCheckFailures);
  assert.deepEqual(card.changes, pr.changes);
  assert.equal(card.checks, "FAILURE");
  assert.equal(prCard({ ...pr, isDraft: true }).prState, "DRAFT");
  assert.equal(prCard({ ...pr, state: "CLOSED", isDraft: true }).prState, "CLOSED");
  assert.equal(prCard({ ...pr, state: "MERGED" }).prState, "MERGED");
  assert.equal(JSON.stringify(card).includes('"branch"'), false);
  assert.equal(JSON.stringify(card).includes('"waitingBy"'), false);
  assert.equal(prCard({ ...pr, url: "file:///tmp/private" }).url, undefined);
});

test("issue cards preserve collapsed sections, merged and closed PR states and HTTPS related links", () => {
  const ticket: ActiveTicket = {
    id: "DEMO-123",
    title: "Billing",
    url: "linear://example/issue/DEMO-123",
    status: "Started",
    statusType: "started",
    priority: { value: 1, name: "Urgent" },
    attachments: [],
    updatedAt: now.toISOString(),
    prs: [],
    otherPRs: [
      { ...pr, state: "MERGED" },
      { ...pr, number: 13, url: "https://github.com/example/app/pull/13", state: "CLOSED", isDraft: true },
    ],
    sessions: [{ ...session, jev: 0.9, associationVersion: 2 }],
    slack: [],
    notion: [],
    reply: null,
    assigned: { at: now, by: "morgan-demo" },
    labels: ["Launch Blocker"],
  };
  const groups = issueGroups({
    sections: [{ title: "Backlog", collapsed: true, tickets: [ticket] }],
    otherPRs: [],
    labelColours: { "launch blocker": "#ff4400" },
  });
  Schema.decodeSync(Group)(groups[0]);
  assert.equal(groups[0].collapsed, true);
  assert.equal(groups[0].cards[0].related[0].detail, "example/app #12 · Merged");
  assert.equal(groups[0].cards[0].url, "https://linear.app/example/issue/DEMO-123");
  assert.equal(groups[0].cards[0].linkTicketId, undefined, "link actions belong only to discovered thread rows");
  assert.equal(JSON.stringify(groups).includes(session.cwd), false);
  const card = groups[0].cards[0];
  assert.equal(card.kind, "issue");
  assert.equal(card.priorityValue, 1);
  assert.equal(card.statusType, "started");
  assert.deepEqual(card.labelColors, { "launch blocker": "#ff4400" });
  assert.deepEqual(
    card.assigned,
    { at: now.toISOString(), people: [{ name: "Morgan P" }] },
    "you are never listed on your own issues",
  );
  assert.equal(card.rows?.[0].merged, true);
  assert.equal(card.rows?.[0].prState, "MERGED");
  assert.equal(card.rows?.[0].prKey, "app#12");
  assert.equal(card.rows?.[0].title, "app#12", "old clients retain their title field");
  assert.deepEqual(card.rows?.[0].checksSummary, pr.checksSummary);
  assert.deepEqual(card.rows?.[0].aiCheckFailures, pr.aiCheckFailures);
  assert.deepEqual(card.rows?.[0].changes, pr.changes);
  assert.equal(card.rows?.[0].checks, "FAILURE");
  assert.equal(card.rows?.[0].status, "MERGED");
  assert.equal(card.rows?.[1].prState, "CLOSED");
  assert.equal(card.rows?.[1].status, "CLOSED");
  assert.equal(card.rows?.[1].merged, false);
  assert.equal(card.rows?.[1].conflictFix, undefined);
  assert.equal(card.related[1].detail, "example/app #13 · Closed");
  assert.deepEqual(
    card.rows?.[0].badges?.map((badge) => badge.text),
    ["conflicts", "reply from Morgan P", "2 AI review threads"],
  );
});

test("health does not expose provider error details", () => {
  const connections = [
    connectionState("linear", true, { ok: true, at: now.toISOString() }),
    connectionState("slack", true, { ok: false, at: now.toISOString() }),
    connectionState("notion", false),
    connectionState("other", true),
  ];
  Schema.decodeSync(HealthResponse)({ version: 1, name: "Mondash", at: now.toISOString(), connections });
  assert.deepEqual(
    connections.map((c) => c.state),
    ["connected", "error", "not-connected", "unknown"],
  );
  assert.equal(connections[0].checkedAt, now.toISOString());
});

test("action input rejects unrelated hosts, invalid ticket IDs and malformed message paths", () => {
  const valid = {
    ticketId: "DEMO-123",
    url: "https://examplehq.slack.com/archives/C123/p2754275190123456?thread_ts=2754275190.123456",
  };
  assert.equal(Schema.decodeSync(LinkInput)(valid).force, false);
  for (const url of [
    "https://slack.com.evil.test/archives/C123/p2754275190123456",
    "http://examplehq.slack.com/archives/C123/p2754275190123456",
    "https://examplehq.slack.com/archives/C123/p2754275190123456garbage",
  ])
    assert.equal(decodes(LinkInput, { ...valid, url }), false);
  assert.equal(decodes(LinkInput, { ...valid, ticketId: "DEMO-123; command" }), false);
  assert.equal(decodes(LinkInput, { ...valid, force: "true" }), false);
});

test("section contract accepts stale empty data but rejects desktop URL leakage", () => {
  const body = {
    version: 1,
    section: "issues",
    generatedAt: now.toISOString(),
    updatedAt: null,
    stale: true,
    groups: [],
  };
  Schema.decodeUnknownSync(SectionResponse)(body);
  assert.equal(
    decodes(SectionResponse, {
      ...body,
      groups: [{ id: "prs", title: "PRs", collapsed: false, cards: [{ ...prCard(pr), url: "codex://session/123" }] }],
    }),
    false,
  );
});

test("scoping matches Mine/To review sections with Slack previews and ticket priority", () => {
  const card: RoadmapCard = {
    id: "card",
    name: "Billing scope",
    url: "notion://www.notion.so/card",
    status: "Scoping",
    priority: "High",
    role: "owner",
    reply: null,
    sessions: [],
    reviewers: ["morgan@example.com"],
    slack: [
      {
        url: "https://examplehq.slack.com/archives/C1/p2754275190123456",
        href: "slack://channel",
        channel: "billing",
        from: "Morgan Park",
        text: "Use the revised pricing",
        replyCount: 3,
        at: now,
      },
    ],
    tickets: [
      {
        id: "DEMO-123",
        title: "Apply pricing",
        status: "Started",
        statusType: "started",
        priority: { value: 2, name: "High" },
        href: "linear://example/issue/DEMO-123",
        jev: 0.9,
        updatedAt: now.toISOString(),
      },
    ],
  };
  const groups = scopingGroups([card, { ...card, id: "review", role: "reviewer" }]);
  groups.forEach((group) => Schema.decodeSync(Group)(group));
  assert.deepEqual(
    groups.map((group) => group.title),
    ["Mine", "To review"],
  );
  assert.equal(groups[0].cards[0].rows?.[0].kind, "notion");
  assert.equal(groups[0].cards[0].rows?.[1].url, "https://linear.app/example/issue/DEMO-123");
  assert.equal(groups[0].cards[0].rows?.[1].priorityValue, 2);
  assert.equal(groups[0].cards[0].rows?.[1].reference, "DEMO-123");
  assert.equal(groups[0].cards[0].rows?.[1].title, "Apply pricing");
  assert.equal(
    groups[0].cards[0].rows?.[1].updatedAt,
    now.toISOString(),
    "the ticket row shows when Linear last changed it",
  );
  assert.equal(groups[0].cards[0].rows?.[2].subtitle, "Morgan P: Use the revised pricing");
  assert.equal(groups[0].cards[0].rows?.[2].updatedAt, now.toISOString());
  assert.deepEqual(groups[1].cards[0].badges?.[0], { text: "you review", tone: "sky" });
  assert.deepEqual(groups[0].cards[0].people, [{ name: "Morgan P" }]);
});

test("review groups preserve urgency colors, your review, reviewers and author faces", () => {
  const review: ReviewItem = {
    key: "app#12",
    links: [],
    tickets: [],
    url: pr.url,
    title: pr.title,
    repo: pr.repo,
    author: "morgan-demo",
    checks: "PENDING",
    checksSummary: { passed: 4, failed: 0, pending: 2, skipped: 1 },
    aiCheckFailures: ["CodeRabbit"],
    branch: "billing",
    isDraft: false,
    createdAt: now,
    lastCommitAt: now,
    threads: [],
    requested: true,
    reviews: [
      {
        author: "renee-demo",
        state: "CHANGES_REQUESTED",
        at: new Date(now.getTime() - 1000),
        isBot: false,
        url: `${pr.url}#old-review`,
      },
      { author: "renee-demo", state: "APPROVED", at: now, isBot: false, url: `${pr.url}#renee-review` },
      { author: "riley", state: "CHANGES_REQUESTED", at: now, isBot: false, url: `${pr.url}#riley-review` },
      { author: "alex", state: "APPROVED", at: now, isBot: false, url: `${pr.url}#alex-review` },
    ],
    waiting: { need: "rereview", at: now, url: pr.url, count: 1 },
    ai: { count: 2, url: `${pr.url}#ai` },
    reviewedBy: ["renee-demo", "riley", "alex"],
    yours: { author: "taylor-demo", state: "APPROVED", at: now, isBot: false, url: `${pr.url}#your-review` },
    sessions: [],
  };
  const groups = reviewGroups({ groups: [{ key: review.key, waiting: review.waiting, prs: [review] }], seen: [] });
  Schema.decodeSync(Group)(groups[0]);
  assert.equal(groups[0].presentation, "review-group");
  assert.equal(groups[0].title, "", "single PRs do not repeat needs-review headings");
  const card = groups[0].cards[0];
  assert.deepEqual(card.author, { name: "Morgan P" });
  assert.equal(card.prKey, "app#12");
  assert.equal(card.prState, "OPEN");
  assert.equal(card.checks, "PENDING");
  assert.deepEqual(card.checksSummary, review.checksSummary);
  assert.deepEqual(card.aiCheckFailures, review.aiCheckFailures);
  assert.deepEqual(card.changes, review.changes);
  assert.deepEqual(
    card.badges?.map((badge) => [badge.text, badge.tone]),
    [
      ["pushed since your review", "violet"],
      ["you approved", "green"],
      ["approved by Renée F", "green"],
      ["approved by alex", "green"],
      ["changes requested by riley", "red"],
      ["2 AI review threads", "violet"],
    ],
  );
  assert.deepEqual(card.badges?.[2].people, [{ name: "Renée F" }]);
  assert.deepEqual(
    card.badges?.slice(1, 5).map((badge) => badge.url),
    [`${pr.url}#your-review`, `${pr.url}#renee-review`, `${pr.url}#alex-review`, `${pr.url}#riley-review`],
    "each reviewer links to their own latest review",
  );
  const unknown = reviewGroups({
    groups: [
      {
        key: review.key,
        waiting: review.waiting,
        prs: [{ ...review, author: "someone-else", reviewedBy: [], yours: null }],
      },
    ],
    seen: [],
  })[0].cards[0];
  assert.equal(unknown.author?.avatar, "https://github.com/someone-else.png?size=32");
  assert.equal(unknown.badges?.[1].text, "no one else yet");
  const linked = reviewGroups({
    groups: [{ key: review.key, waiting: review.waiting, prs: [{ ...review, tickets: ["DEMO-123", "DEMO-123"] }] }],
    seen: [],
  })[0].cards[0];
  assert.deepEqual(linked.rows, [
    { kind: "ticket", title: "DEMO-123", reference: "DEMO-123", url: "https://linear.app/example/issue/DEMO-123" },
  ]);
  assert.deepEqual(card.rows, []);
});

test("standalone PRs preserve ticket references instead of appearing unlinked", () => {
  const linked = prCard({ ...pr, title: "Fix DEMO-123 billing", branch: "demo-123-billing" });
  assert.deepEqual(linked.rows, [
    { kind: "ticket", title: "DEMO-123", reference: "DEMO-123", url: "https://linear.app/example/issue/DEMO-123" },
  ]);
  assert.deepEqual(prCard(pr).rows, []);
});

test("legacy cached cards still parse without the new presentation fields", () => {
  const old = {
    id: "DEMO-1",
    kind: "issue",
    title: "A task",
    subtitle: "DEMO-1",
    status: "Started",
    attention: [],
    labels: [],
    links: [],
    sessions: [],
    related: [],
  };
  const payload = Schema.decodeUnknownSync(SectionResponse)({
    version: 1,
    section: "issues",
    generatedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    stale: false,
    groups: [{ id: "started", title: "Started", collapsed: false, cards: [old] }],
  });
  assert.equal(payload.groups[0].presentation, undefined);
  assert.equal(payload.groups[0].cards[0].rows, undefined);
});

test("other pull requests expose their matched sessions without private Mac details", () => {
  const groups = issueGroups({
    sections: [],
    otherPRs: [
      {
        ...pr,
        sessions: [
          { ...session, jev: 0.9, associationVersion: 2 },
          { ...session, id: "F828D7E6-F804-57F2-AEC7-131E5D46DE3D", tool: "codex", jev: 0.9, associationVersion: 2 },
        ],
      },
    ],
    labelColours: {},
  });
  Schema.decodeSync(Group)(groups[0]);
  const card = groups[0].cards[0];
  assert.equal(groups[0].id, "other-prs");
  assert.equal(card.sessions.length, 2);
  assert.equal(card.sessions[0].canOpenInClaude, true);
  assert.equal(card.sessions[1].canOpenInChatGPT, true);
  assert.equal(JSON.stringify(card).includes(session.cwd), false);
  assert.equal(JSON.stringify(card).includes(session.firstPrompt), false);
  assert.deepEqual(prCard(pr).sessions, [], "older snapshots without associations remain valid");
});

test("draft work uses rich PR cards with checks, review attention and matched sessions", () => {
  const groups = issueGroups({
    sections: [],
    otherPRs: [],
    draftPRs: [{ ...pr, isDraft: true, sessions: [{ ...session, jev: 0.9, associationVersion: 2 }] }],
    labelColours: {},
  });
  Schema.decodeSync(Group)(groups[0]);
  const card = groups[0].cards[0];
  assert.equal(groups[0].id, "draft-prs");
  assert.equal(card.prState, "DRAFT");
  assert.deepEqual(card.changes, pr.changes);
  assert.deepEqual(card.checksSummary, pr.checksSummary);
  assert.deepEqual(card.aiCheckFailures, pr.aiCheckFailures);
  assert.equal(card.sessions[0].id, session.id);
  assert.ok(card.badges?.some((badge) => badge.text.includes("conflict")));
});

test("the inbox groups by local day and keeps the actor, reason and source", async () => {
  const { inboxGroups } = await import("./presenters.ts");
  const now = new Date(2026, 8, 25, 12);
  const item = (id: string, at: Date) => ({
    id,
    source: "github" as const,
    kind: "comment",
    title: "web#1 Fix",
    url: "https://github.com/ExampleOrg/web/pull/1",
    at,
    reason: "commented",
    actor: "morgan-demo",
    push: true,
  });
  const groups = inboxGroups(
    [
      item("a", new Date(2026, 8, 25, 9)),
      item("b", new Date(2026, 8, 24, 23)),
      item("c", new Date(2026, 8, 20)),
      item("d", new Date(2026, 8, 18, 23)),
    ],
    (i) => i.id !== "a",
    now,
  );
  assert.deepEqual(
    groups.map((g) => [g.title, g.cards.map((c) => c.id)]),
    [
      ["Today", ["a"]],
      ["Yesterday", ["b"]],
      ["This week", ["c"]],
      ["Earlier", ["d"]],
    ],
  );
  assert.equal(groups[0].cards[0].feedSource, "github");
  assert.equal(groups[0].cards[0].feedTab, "threads", "a comment continues a conversation");
  assert.deepEqual(
    groups.map((g) => g.cards[0].unread),
    [true, false, false, false],
  );
  assert.equal(groups[0].cards[0].author?.name, "Morgan P");
  groups.forEach((g) => Schema.decodeSync(Group)(g));
});

test("the inbox renders emoji in cached Slack snippets without interpreting other sources", async () => {
  const { inboxGroups } = await import("./presenters.ts");
  const at = new Date();
  const item = {
    id: "slack:dm:1",
    source: "slack" as const,
    kind: "dm",
    title: "Direct message",
    snippet: ":+1::+1::+1:",
    url: "https://example.slack.com/archives/D1/p1",
    at,
    reason: "sent you a message",
    push: true,
  };
  const [group] = inboxGroups([item, { ...item, id: "github:1", source: "github" }], undefined, at);
  assert.equal(group.cards[0].subtitle, "👍👍👍");
  assert.equal(group.cards[1].subtitle, ":+1::+1::+1:");
});

test("Calendar reminders preserve exact times and actionable HTTPS links at the Inbox boundary", async () => {
  const { inboxGroups } = await import("./presenters.ts");
  const at = new Date();
  const calendarEvent = { startsAt: "2026-10-01T14:30:00.000Z", endsAt: "2026-10-01T15:30:00.000Z" };
  const [group] = inboxGroups(
    [
      {
        id: "calendar:1",
        source: "slack",
        kind: "dm",
        title: "Daily Check-in",
        snippet: "3:30 PM – 4:30 PM",
        url: "https://example.slack.com/archives/D1/p1",
        at,
        reason: "Event reminder",
        push: true,
        calendarEvent,
        links: [
          { title: "Join Google Meet", url: "https://meet.google.com/abc-defg-hij" },
          { title: "Unsafe", url: "javascript:alert(1)" },
        ],
      },
    ],
    undefined,
    at,
  );
  const card = group.cards[0];
  assert.equal(card.title, "Daily Check-in");
  assert.deepEqual(card.calendarEvent, calendarEvent);
  assert.equal(card.links.length, 1);
  assert.equal(card.feedTab, "direct");
  Schema.decodeSync(Group)(group);
});

test("a conflicting open PR carries repair instructions covering the ticket's other PRs; a merged one does not", () => {
  const web = {
    ...pr,
    repo: "example/web",
    number: 7,
    url: "https://github.com/example/web/pull/7",
    branch: "billing",
    conflicts: false,
  };
  const ticket: ActiveTicket = {
    id: "DEMO-9",
    title: "Billing",
    url: "https://linear.app/example/issue/DEMO-9",
    status: "Started",
    statusType: "started",
    priority: { value: 2, name: "High" },
    attachments: [],
    updatedAt: now.toISOString(),
    prs: [pr, web],
    otherPRs: [{ ...pr, state: "MERGED", number: 3, url: "https://github.com/example/app/pull/3" }],
    sessions: [],
    slack: [],
    notion: [],
    reply: null,
    assigned: { at: now, by: "morgan-demo" },
  };
  const rows =
    issueGroups({
      sections: [{ title: "Now", collapsed: false, tickets: [ticket] }],
      otherPRs: [],
      labelColours: {},
    })[0].cards[0].rows ?? [];
  const fix = rows.find((row) => row.url === pr.url)?.conflictFix;
  assert.ok(fix?.prompt.includes("for DEMO-9"));
  assert.ok(fix?.prompt.includes(web.url), "the related PR is brought up to date too");
  assert.equal(rows.find((row) => row.url === web.url)?.conflictFix, undefined);
  assert.equal(rows.find((row) => row.merged)?.conflictFix, undefined);
  const unconfigured = prCard({
    ...pr,
    repo: "unconfigured/repository",
    url: "https://github.com/unconfigured/repository/pull/12",
  });
  assert.ok(unconfigured.conflictFix?.folder, "an unconfigured checkout can still start a repair session");
  assert.ok(unconfigured.conflictFix?.prompt.includes(unconfigured.url!));
});

test("archived sessions move to an Archived group after the recent ones", () => {
  const groups = sessionGroups([
    { ...session, id: "old", archived: true },
    { ...session, id: "live" },
  ]);
  assert.deepEqual(
    groups.map((group) => [group.title, group.cards.map((card) => card.id)]),
    [
      ["Recent agent sessions", ["live"]],
      ["Archived", ["old"]],
    ],
  );
  assert.equal(groups[1].cards[0].sessions[0].archived, true);
  assert.equal(sessionGroups([session]).length, 1);
});

test("native review stacks combine paired layers without changing the review feed's action groups", async () => {
  const item = (repo: string, number: number): ReviewItem => ({
    key: `${repo}#${number}`,
    repo: `example/${repo}`,
    title: `${repo} change ${number}`,
    url: `https://github.com/example/${repo}/pull/${number}`,
    author: "someone-else",
    branch: `change-${number}`,
    isDraft: false,
    createdAt: now,
    lastCommitAt: now,
    links: [],
    tickets: [],
    threads: [],
    reviews: [],
    requested: true,
    waiting: { need: "review", at: now, url: `https://github.com/example/${repo}/pull/${number}`, count: 1 },
    reviewedBy: [],
    sessions: [],
    ai: null,
    yours: null,
  });
  const entries = [2474, 2501, 2460, 2465].map((number, index) => ({
    position: index + 1,
    number,
    title: `Layer ${number}`,
    url: `https://github.com/example/core/pull/${number}`,
    status: index < 2 ? ("Approval needed" as const) : ("Draft" as const),
  }));
  const first = { ...item("core", 2474), stack: { number: 2502, position: 1, size: 4, base: "main", entries } };
  const second = { ...item("core", 2501), stack: { ...first.stack, position: 2 } };
  const feed = {
    groups: [
      { key: "second", waiting: second.waiting, prs: [second, item("web", 2021)] },
      { key: "first", waiting: first.waiting, prs: [first, item("web", 1993)] },
    ],
    seen: [],
  };
  const result = reviewGroups(feed);
  const scope = await createReviewScopeResolver({
    groups: async () => feed.groups.map((group) => group.prs),
    cwd: async () => "/workspace",
    forTicket: async () => [],
    load: async (url) => ({
      url,
      title: "Change",
      body: "",
      branch: "feature",
      state: "OPEN",
      comments: [],
      ready: true,
    }),
  })(first.url);
  assert.deepEqual(
    new Set(scope.urls),
    new Set([first.url, item("web", 1993).url]),
    "Review keeps the selected layer and its paired PR, not the whole native stack",
  );
  assert.equal(result.length, 1, "one presentation group for the native stack");
  Schema.decodeSync(Group)(result[0]);
  assert.equal(result[0].presentation, "review-stack");
  assert.equal(result[0].cards.length, 4, "paired PRs appear once; drafts remain context, not actionable cards");
});

test("Inbox work references survive presentation for normal ticket enrichment", async () => {
  const { inboxGroups } = await import("./presenters.ts");
  const at = new Date("2026-10-06T12:00:00Z");
  const common = { at, kind: "comment", title: "Discussion", reason: "commented", push: false };
  const [group] = inboxGroups(
    [
      {
        ...common,
        id: "linear:notice",
        source: "linear",
        url: "https://linear.app/example/issue/DEMO-42/changed#comment",
      },
      {
        ...common,
        id: "slack:saved",
        source: "slack",
        url: "https://example.slack.com/archives/C123/p1770000000000001",
        tickets: [
          {
            id: "DEMO-43",
            url: "https://linear.app/example/issue/DEMO-43/a",
            status: "Todo",
            statusType: "unstarted",
            priority: { value: 2, name: "High" },
            mine: false,
          },
        ],
      },
    ],
    undefined,
    at,
  );
  assert.deepEqual(
    group.cards.map((card) => card.rows?.map((row) => row.reference)),
    [["DEMO-42"], ["DEMO-43"]],
  );
  for (const card of group.cards) assert.equal(card.rows?.[0].kind, "ticket");
});

test("linked work uses current context receipts without changing its cached associations", () => {
  const linked = { ...session, jev: 0.88, contextUsage: { usedTokens: 900000, windowTokens: 1000000 } };
  const groups = [prCard({ ...pr, sessions: [linked] })];
  const before: Group[] = [{ id: "reviews", title: "Reviews", collapsed: false, cards: groups }];
  const latest = { ...session, contextUsage: { usedTokens: 64003, windowTokens: 1000000 } };
  const [fresh] = withSessionContext(before, [latest, { ...latest, tool: "codex", contextUsage: { usedTokens: 5 } }]);
  assert.deepEqual(fresh.cards[0].sessions[0].contextUsage, { usedTokens: 64003, windowTokens: 1000000 });
  assert.equal(fresh.cards[0].sessions[0].jev, 0.88);
  const newer: Group[] = before.map((group) => ({
    ...group,
    cards: group.cards.map((card) => ({
      ...card,
      sessions: card.sessions.map((entry) => ({ ...entry, updatedAt: new Date(now.getTime() + 60000).toISOString() })),
    })),
  }));
  assert.deepEqual(withSessionContext(newer, [latest])[0].cards[0].sessions[0].contextUsage, {
    usedTokens: 900000,
    windowTokens: 1000000,
  });
  assert.deepEqual(before[0].cards[0].sessions[0].contextUsage, { usedTokens: 900000, windowTokens: 1000000 });
  assert.equal(withSessionContext(before, [{ ...session }])[0].cards[0].sessions[0].contextUsage, undefined);
  assert.deepEqual(withSessionContext(before, [])[0].cards[0].sessions[0].contextUsage, {
    usedTokens: 900000,
    windowTokens: 1000000,
  });
});
