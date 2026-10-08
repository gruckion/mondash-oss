import { itemUrlKey } from "@mondash/shared/linked-items";
import { groupReviewStacks } from "@mondash/shared/review-stacks";
import { profile, actionDirectory, ticketUrl } from "../profile";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  HealthResponse,
  Card,
  Group,
  Session,
  SessionPRStatus,
  Person,
  Badge,
  Row,
  ConflictFix,
} from "@mondash/shared/contract";
import { sessionPRIdentities } from "./session-prs";
import { conflictPrompt, type ConflictPR } from "@mondash/shared/conflict-prompt";
import type { AgentSession } from "./sessions.ts";
import type { Resume, ActiveTicket, UnlinkedThread } from "./resume.ts";
import type { RoadmapCard } from "./notion.ts";
import type { PullRequest } from "./github.ts";
import type { ReviewFeed, ReviewItem } from "./github-feed.ts";
import type { FeedItem } from "./feed.ts";
import { DAY_GROUPS, dayGroup, feedTab } from "./feed-tabs.ts";
import { reviewerStates } from "./review-feed.ts";
import type { Ticket } from "./triage.ts";
import { displayName, ME, isMe, person, type Reply } from "./people.ts";
import { emojiText, plain } from "./slack.ts";
import { unattachedThreads } from "./thread-discovery.ts";
import { refKeys } from "./refs.ts";

/** Undo desktop-only links at the API boundary. Never infer iPhone apps from the Mac. */
export function webLink(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === "linear:") return `https://linear.app/${url.host}${url.pathname}${url.search}${url.hash}`;
    if (url.protocol === "notion:") {
      url.searchParams.delete("deepLinkOpenNewTab");
      return `https://${url.host}${url.pathname}${url.search}${url.hash}`;
    }
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

const links = (items: ReadonlyArray<{ title: string; url: string }>) =>
  items.flatMap((item) => {
    const url = webLink(item.url);
    return url ? [{ title: item.title, url }] : [];
  });
const related = (items: ReadonlyArray<{ title: string; detail: string; url: string }>) =>
  items.flatMap((item) => {
    const url = webLink(item.url);
    return url ? [{ ...item, url }] : [];
  });
const replyText = (reply: Reply | null) =>
  reply
    ? [`${reply.count} ${reply.count === 1 ? "reply" : "replies"} waiting · ${reply.from.map(displayName).join(", ")}`]
    : [];
const replyLinks = (reply: Reply | null) => (reply ? links([{ title: "Read replies", url: reply.url }]) : []);
const base = (id: string, title: string, subtitle: string, status: string): Omit<Card, "kind"> => ({
  id,
  title,
  subtitle,
  status,
  attention: [],
  labels: [],
  links: [],
  sessions: [],
  related: [],
});

const iso = (date: Date | string) => new Date(date).toISOString();
const people = (keys: ReadonlyArray<string>, githubFallback = false): Person[] =>
  keys.map((key) => ({
    name: displayName(key),
    // Known colleagues are enriched from Slack on the server. Unknown GitHub authors use their public avatar.
    ...(githubFallback && !person(key) && /^[a-zA-Z0-9-]+$/.test(key)
      ? { avatar: `https://github.com/${key}.png?size=32` }
      : {}),
  }));
const replyBadges = (reply: Reply | null): Badge[] =>
  reply
    ? [
        {
          text: `${reply.count === 1 ? "reply" : `${reply.count} replies`} from ${reply.from.map(displayName).join(", ")}`,
          tone: "amber",
          url: webLink(reply.url),
          people: people(reply.from, true),
        },
      ]
    : [];
const CHECK_BADGES: Record<string, Badge> = {
  SUCCESS: { text: "✓ checks", tone: "green" },
  FAILURE: { text: "✗ checks failing", tone: "red" },
  ERROR: { text: "✗ checks error", tone: "red" },
  PENDING: { text: "● checks running", tone: "amber" },
};
const REVIEW_BADGES: Record<string, Badge> = {
  MERGED: { text: "merged", tone: "violet" },
  APPROVED: { text: "approved", tone: "green" },
  CHANGES_REQUESTED: { text: "changes requested", tone: "red" },
  REVIEW_REQUIRED: { text: "needs review", tone: "neutral" },
};
function prBadges(pr: PullRequest, merged = false): Badge[] {
  const review = merged ? "MERGED" : pr.review;
  return [
    ...(pr.isDraft ? [{ text: "draft", tone: "neutral" as const }] : []),
    ...(review && REVIEW_BADGES[review] ? [REVIEW_BADGES[review]] : []),
    ...(pr.checks && CHECK_BADGES[pr.checks] ? [CHECK_BADGES[pr.checks]] : []),
    ...prAttentionBadges(pr),
  ];
}
function prAttentionBadges(pr: PullRequest): Badge[] {
  return [
    ...(pr.dm
      ? [
          {
            text: `DM from ${displayName(pr.dm.from)}`,
            jev: pr.dm.jev,
            tone: "amber" as const,
            url: webLink(pr.dm.url),
            people: people([pr.dm.from]),
          },
        ]
      : []),
    ...(pr.conflicts ? [{ text: "conflicts", tone: "red" as const }] : []),
    ...replyBadges(pr.reply),
    ...(pr.aiThreads
      ? [
          {
            text: `${pr.aiThreads.count} AI review thread${pr.aiThreads.count === 1 ? "" : "s"}`,
            tone: "violet" as const,
            url: webLink(pr.aiThreads.url),
          },
        ]
      : []),
  ];
}
const rows = (items: Row[]): Row[] =>
  items.flatMap((row) => {
    const url = webLink(row.url);
    return url ? [{ ...row, url }] : [];
  });
const prState = (pr: { state?: "OPEN" | "MERGED" | "CLOSED"; isDraft: boolean }, merged = false): Row["prState"] =>
  merged || pr.state === "MERGED" ? "MERGED" : pr.state === "CLOSED" ? "CLOSED" : pr.isDraft ? "DRAFT" : "OPEN";

const conflictPR = (pr: PullRequest): ConflictPR => ({ url: pr.url, repo: pr.repo, branch: pr.branch });
/** The fix for a conflicting PR, covering its related PRs (e.g. core and web for one ticket) as well. */
const conflictFix = (
  pr: PullRequest,
  related: ReadonlyArray<PullRequest> = [],
  ticket?: string,
): { conflictFix?: ConflictFix } => {
  if (!pr.conflicts) return {};
  const folder = actionDirectory(...(pr.repo.split("/") as [string, string])) ?? profile.runtime.newSessionDir;
  return {
    conflictFix: { prompt: conflictPrompt(conflictPR(pr), related.map(conflictPR), ticket, folder), folder },
  };
};

const prRow = (pr: PullRequest, merged = false, related: ReadonlyArray<PullRequest> = [], ticket?: string): Row => ({
  kind: "pr",
  title: `${pr.repo.split("/").at(-1)}#${pr.number}`,
  subtitle: pr.title,
  url: pr.url,
  status: merged || pr.state === "MERGED" ? "MERGED" : pr.state === "CLOSED" ? "CLOSED" : (pr.review ?? "Open"),
  ...(pr.checks ? { checks: pr.checks } : {}),
  draft: pr.isDraft,
  prKey: `${pr.repo.split("/").at(-1)}#${pr.number}`,
  prState: prState(pr, merged),
  checksSummary: pr.checksSummary,
  stack: pr.stack,
  aiCheckFailures: pr.aiCheckFailures,
  changes: pr.changes,
  merged,
  badges: prAttentionBadges(pr),
  updatedAt: iso(pr.updatedAt),
  ...(merged || pr.state === "MERGED" || pr.state === "CLOSED" ? {} : conflictFix(pr, related, ticket)),
});

export function sessionView(session: AgentSession & { jev?: number }): Session {
  return {
    id: session.id,
    tool: session.tool,
    title: session.title,
    updatedAt: session.updatedAt.toISOString(),
    canOpenOnMac: false, // Kept for older v1 clients; the Mac button calls openInTerminal instead.
    canOpenInClaude: session.tool === "claude",
    canOpenInChatGPT: session.tool === "codex",
    ...(session.preview ? { preview: session.preview, previewKind: session.previewKind } : {}),
    ...(session.jev === undefined ? {} : { jev: session.jev }),
    ...(session.archived === undefined ? {} : { archived: session.archived }),
    canArchive: session.tool === "codex",
    ...(session.running === undefined ? {} : { running: session.running }),
    ...(session.contextUsage === undefined ? {} : { contextUsage: session.contextUsage }),
  };
}

export function prCard(pr: PullRequest & { sessions?: ReadonlyArray<AgentSession> }): Card {
  return {
    ...base(pr.url, pr.title, `${pr.repo} #${pr.number}`, pr.isDraft ? "Draft" : (pr.review ?? "Open")),
    prKey: `${pr.repo.split("/").at(-1)}#${pr.number}`,
    prState: prState(pr),
    ...(pr.checks ? { checks: pr.checks } : {}),
    checksSummary: pr.checksSummary,
    stack: pr.stack,
    aiCheckFailures: pr.aiCheckFailures,
    changes: pr.changes,
    ...(pr.review ? { reviewDecision: pr.review } : {}),
    kind: "pr",
    badges: prBadges(pr),
    rows: ticketRows(
      refKeys(`${pr.title} ${pr.branch}`)
        .filter((ref) => profile.workspace.ticketPrefixes.some((prefix) => ref.startsWith(`ticket:${prefix}-`)))
        .map((ref) => ref.slice(7)),
    ),
    sessions: (pr.sessions ?? []).map(sessionView),
    url: webLink(pr.url),
    updatedAt: pr.updatedAt.toISOString(),
    attention: [
      ...replyText(pr.reply),
      ...(pr.conflicts ? ["Merge conflicts"] : []),
      ...(pr.checks === "FAILURE" || pr.checks === "ERROR" ? ["Checks failing"] : []),
      ...(pr.aiThreads ? [`${pr.aiThreads.count} AI review threads`] : []),
      ...(pr.dm ? [`DM waiting · ${displayName(pr.dm.from)}`] : []),
    ],
    links: [
      ...replyLinks(pr.reply),
      ...links(pr.dm ? [{ title: "Open Slack DM", url: pr.dm.url }] : []),
      ...links(pr.aiThreads ? [{ title: "AI review threads", url: pr.aiThreads.url }] : []),
    ],
    labels: pr.checks ? [`Checks: ${pr.checks.toLowerCase()}`] : [],
    ...conflictFix(pr),
  };
}

const ticketRows = (tickets: ReadonlyArray<string>): Row[] =>
  [...new Set(tickets)].map((id) => ({
    kind: "ticket",
    title: id,
    reference: id,
    url: ticketUrl(id),
  }));

export function ticketRow(
  ticket: Pick<Ticket, "id" | "title" | "url" | "status" | "statusType" | "priority"> & { updatedAt?: Date | string },
  mine = false,
): Row {
  return {
    kind: "ticket",
    reference: ticket.id,
    title: ticket.title,
    url: webLink(ticket.url) ?? ticketUrl(ticket.id),
    status: ticket.status,
    statusType: ticket.statusType,
    priority: ticket.priority.name,
    priorityValue: ticket.priority.value,
    // The cache revives ISO strings into Dates, so either can arrive.
    ...(ticket.updatedAt ? { updatedAt: iso(ticket.updatedAt) } : {}),
    ...(mine ? { owner: people([ME])[0] } : {}),
  };
}

function ticketCard(
  ticket: ActiveTicket,
  labelColours: Readonly<Record<string, string>>,
  candidates: ReadonlyArray<UnlinkedThread>,
): Card {
  const prs = [...ticket.prs, ...ticket.otherPRs];
  return {
    ...base(ticket.id, ticket.title, ticket.id, ticket.status),
    url: webLink(ticket.url),
    kind: "issue",
    statusType: ticket.statusType,
    priorityValue: ticket.priority.value,
    labelColors: Object.fromEntries(
      (ticket.labels ?? []).map((label) => [label.toLowerCase(), labelColours[label.toLowerCase()] ?? "#95a2b3"]),
    ),
    assigned: { at: iso(ticket.assigned.at), people: people(ticket.assigned.by ? [ticket.assigned.by] : []) },
    badges: replyBadges(ticket.reply),
    rows: rows([
      ...ticket.notion.map((link): Row => ({ kind: "notion", title: link.title, url: link.url })),
      ...ticket.prs.map((pr) => prRow(pr, false, ticket.prs, ticket.id)),
      ...ticket.slack.map((thread): Row => ({
        kind: "slack",
        title: thread.title,
        url: thread.url,
        subtitle: [thread.channel ? `#${thread.channel}` : undefined, thread.subtitle].filter(Boolean).join(": "),
        updatedAt: thread.postedAt ? iso(thread.postedAt) : undefined,
      })),
      ...ticket.otherPRs.map((pr) => prRow(pr, pr.state === "MERGED")),
      ...unattachedThreads(ticket, candidates).map((thread): Row => ({
        kind: "slack",
        title: thread.channel,
        url: thread.url,
        linkTicketId: ticket.id,
        subtitle: `${displayName(thread.from)}: ${plain(thread.text)}`,
        updatedAt: thread.lastAt ? iso(thread.lastAt) : undefined,
        badges:
          thread.replyCount > 0
            ? [
                {
                  text: `${thread.replyCount} ${thread.replyCount === 1 ? "reply" : "replies"}${thread.participants.length ? ` · ${thread.participants.map(displayName).join(", ")}` : ""}`,
                  tone: "neutral",
                  people: people(thread.participants),
                },
              ]
            : [],
      })),
    ]),
    priority: ticket.priority.name,
    updatedAt: new Date(ticket.updatedAt).toISOString(),
    attention: [
      ...replyText(ticket.reply),
      ...ticket.prs.flatMap((pr) => prCard(pr).attention.map((a) => `#${pr.number}: ${a}`)),
    ],
    labels: ticket.labels ?? [],
    sessions: ticket.sessions.map(sessionView),
    links: [
      ...replyLinks(ticket.reply),
      ...links(ticket.slack.map((s) => ({ title: s.channel ? `Slack · #${s.channel}` : s.title, url: s.url }))),
      ...links(ticket.notion),
      ...ticket.prs.flatMap((pr) => prCard(pr).links),
    ],
    related: related(
      prs.map((pr) => ({
        title: pr.title,
        detail: `${pr.repo} #${pr.number} · ${pr.state === "MERGED" ? "Merged" : pr.state === "CLOSED" ? "Closed" : pr.isDraft ? "Draft" : (pr.review ?? "Open")}`,
        url: pr.url,
      })),
    ),
  };
}

export function issueGroups(
  resume: Resume,
  discovered: ReadonlyMap<string, ReadonlyArray<UnlinkedThread>> = new Map(),
): Group[] {
  return [
    ...resume.sections.map((section) => ({
      id: section.title,
      title: section.title,
      collapsed: section.collapsed,
      presentation: "section" as const,
      cards: section.tickets.map((ticket) => ticketCard(ticket, resume.labelColours, discovered.get(ticket.id) ?? [])),
    })),
    ...(resume.otherPRs.length
      ? [{ id: "other-prs", title: "Other pull requests", collapsed: false, cards: resume.otherPRs.map(prCard) }]
      : []),
    ...(resume.draftPRs?.length
      ? [{ id: "draft-prs", title: "Draft pull requests", collapsed: false, cards: resume.draftPRs.map(prCard) }]
      : []),
  ];
}

const NOTION_PRIORITY: Record<string, number> = { High: 2, Medium: 3, Low: 4 };

export function scopingGroups(cards: ReadonlyArray<RoadmapCard>): Group[] {
  return (["owner", "reviewer"] as const).map((role) => ({
    id: role === "owner" ? "mine" : "to-review",
    title: role === "owner" ? "Mine" : "To review",
    presentation: "section",
    collapsed: false,
    cards: cards
      .filter((card) => card.role === role)
      .map((card) => ({ ...card, reviewers: (card.reviewers ?? []).filter((r) => !isMe(r)) }))
      .map((card) => ({
        ...base(card.id, card.name, card.role === "owner" ? "You own this" : "Your review", card.status),
        kind: "scoping",
        url: webLink(card.url),
        priority: card.priority,
        // On Linear's scale (1 is Urgent), so the grey box draws the same bars as on issues.
        priorityValue: card.priority ? NOTION_PRIORITY[card.priority] : undefined,
        attention: replyText(card.reply),
        people: people(card.reviewers ?? []),
        badges: [
          ...(card.role === "reviewer" ? [{ text: "you review", tone: "sky" as const }] : []),
          ...replyBadges(card.reply),
          ...((card.reviewers ?? []).length
            ? [
                {
                  text: `${card.reviewers.map(displayName).join(", ")} reviews`,
                  tone: "neutral" as const,
                  people: people(card.reviewers),
                },
              ]
            : []),
        ],
        labels: (card.reviewers ?? []).map((r) => `Reviewer: ${displayName(r)}`),
        sessions: card.sessions.map(sessionView),
        links: [
          ...replyLinks(card.reply),
          ...links(
            card.slack.map((s) => ({ title: `Slack${s.channel ? ` · #${s.channel}` : " discussion"}`, url: s.url })),
          ),
        ],
        related: related(
          card.tickets.map((ticket) => ({
            title: `${ticket.id} · ${ticket.title}`,
            detail: ticket.status,
            url: ticket.href,
          })),
        ),
        rows: rows([
          // The doc itself heads the card, drawn like the Notion row under an issue.
          { kind: "notion", title: card.name, url: card.url },
          ...card.tickets.map((ticket): Row => ({ ...ticketRow({ ...ticket, url: ticket.href }), jev: ticket.jev })),
          ...card.slack.map((thread): Row => ({
            kind: "slack",
            title: thread.channel ? `#${thread.channel}` : "Slack discussion",
            subtitle: [thread.from ? displayName(thread.from) : undefined, thread.text].filter(Boolean).join(": "),
            url: thread.url,
            updatedAt: thread.at ? iso(thread.at) : undefined,
            badges: thread.replyCount ? [{ text: `${thread.replyCount} replies`, tone: "neutral" }] : [],
          })),
        ]),
      })),
  }));
}

const REVIEWED: Record<string, { text: string; tone: Badge["tone"] }> = {
  APPROVED: { text: "approved by", tone: "green" },
  CHANGES_REQUESTED: { text: "changes requested by", tone: "red" },
  COMMENTED: { text: "commented by", tone: "neutral" },
  OTHER: { text: "reviewed by", tone: "neutral" },
};

/** One lip per reviewer, with their own destination and latest review state. */
function reviewedBadges(pr: ReviewItem): Badge[] {
  const states = reviewerStates(pr);
  if (!states.length) return [{ text: "no one else yet", tone: "neutral" }];
  return states.flatMap(({ state, reviewers }) =>
    reviewers.map(({ login, url }) => ({
      text: `${REVIEWED[state].text} ${displayName(login)}`,
      tone: REVIEWED[state].tone,
      people: people([login], true),
      url: url ? webLink(url) : undefined,
    })),
  );
}

export function reviewGroups(feed: ReviewFeed): Group[] {
  const groups: Group[] = feed.groups.map((group) => ({
    id: group.key,
    title:
      group.prs.length > 1 ? `${group.prs.length} PRs, one change: ${group.prs.map((pr) => pr.key).join(" + ")}` : "",
    presentation: "review-group",
    collapsed: false,
    cards: group.prs.map((pr) => ({
      ...base(
        pr.key,
        pr.title,
        `${pr.repo} · ${displayName(pr.author)}`,
        pr.waiting.need === "reply"
          ? "Reply waiting"
          : pr.waiting.need === "rereview"
            ? "Updated since your review"
            : "Review requested",
      ),
      reviewGroupId: group.key,
      reviewCompanions: group.prs
        .filter((other) => pr.links.includes(other.key) || other.links.includes(pr.key))
        .map((other) => other.url),
      prKey: pr.key,
      prState: prState(pr),
      ...(pr.checks ? { checks: pr.checks } : {}),
      checksSummary: pr.checksSummary,
      stack: pr.stack,
      aiCheckFailures: pr.aiCheckFailures,
      changes: pr.changes,
      ...(pr.review ? { reviewDecision: pr.review } : {}),
      kind: "review",
      author: people([pr.author], true)[0],
      people: people(pr.reviewedBy, true),
      rows: ticketRows(pr.tickets),
      url: webLink(pr.url),
      updatedAt: iso(pr.waiting.at),
      sessions: pr.sessions.map(sessionView),
      attention:
        pr.waiting.need === "reply"
          ? [`${pr.waiting.count} unanswered ${pr.waiting.count === 1 ? "thread" : "threads"}`]
          : [],
      badges: [
        {
          text:
            pr.waiting.need === "reply"
              ? pr.waiting.count === 1
                ? "replied to you"
                : `${pr.waiting.count} replies to you`
              : pr.waiting.need === "rereview"
                ? "pushed since your review"
                : "needs your review",
          tone: pr.waiting.need === "reply" ? "amber" : pr.waiting.need === "rereview" ? "violet" : "sky",
          url: webLink(pr.waiting.url),
          ...(pr.waiting.from ? { people: people(pr.waiting.from, true) } : {}),
        },
        ...(pr.yours
          ? [
              {
                ...(pr.yours.state === "APPROVED"
                  ? { text: "you approved", tone: "green" as const }
                  : pr.yours.state === "CHANGES_REQUESTED"
                    ? { text: "you asked for changes", tone: "red" as const }
                    : { text: "you commented", tone: "neutral" as const }),
                people: people([pr.yours.author], true),
                url: pr.yours.url ? webLink(pr.yours.url) : undefined,
              },
            ]
          : []),
        ...reviewedBadges(pr),
        ...(pr.ai
          ? [
              {
                text: `${pr.ai.count} AI review thread${pr.ai.count === 1 ? "" : "s"}`,
                tone: "violet" as const,
                url: webLink(pr.ai.url),
              },
            ]
          : []),
      ],
      labels: [
        ...pr.reviewedBy.map((r) => `Reviewed: ${displayName(r)}`),
        ...(pr.yours ? [`Your review: ${pr.yours.state.toLowerCase().replaceAll("_", " ")}`] : []),
      ],
      links: links([
        { title: "View review", url: pr.waiting.url },
        ...(pr.ai ? [{ title: `${pr.ai.count} AI review threads`, url: pr.ai.url }] : []),
      ]),
    })),
  }));
  return groupReviewStacks(groups);
}

/** Refresh local usage independently of the cached work associations and Jev scores. */
export function withSessionContext(groups: readonly Group[], sessions: readonly AgentSession[]): Group[] {
  const latest = new Map(sessions.map((session) => [`${session.tool}:${session.id}`, session]));
  return groups.map((group) => ({
    ...group,
    cards: group.cards.map((card) => ({
      ...card,
      sessions: card.sessions.map((session) => {
        const found = latest.get(`${session.tool}:${session.id}`);
        const newer = found && found.updatedAt.getTime() >= Date.parse(session.updatedAt);
        return newer ? { ...session, contextUsage: found.contextUsage } : session;
      }),
    })),
  }));
}

export function sessionGroups(
  sessions: ReadonlyArray<AgentSession>,
  statuses: ReadonlyMap<string, SessionPRStatus> = new Map(),
): Group[] {
  const cards = (list: ReadonlyArray<AgentSession>, status: string): Card[] =>
    list.map((session) => ({
      ...base(session.id, session.title, session.tool === "claude" ? "Claude Code" : "Codex", status),
      kind: "session",
      updatedAt: session.updatedAt.toISOString(),
      sessions: [
        {
          ...sessionView(session),
          pullRequests: sessionPRIdentities(session)
            .slice(0, 30)
            .flatMap((pr) => {
              const status = statuses.get(pr.url.toLowerCase());
              return status ? [status] : [];
            }),
        },
      ],
      links: links(
        (session.linkedPRs ?? []).flatMap((ref) => {
          const match = ref.match(/^pr:([\w.-]+\/[\w.-]+)#([1-9]\d*)$/);
          return match
            ? [
                {
                  title: `${match[1].split("/").at(-1)}#${match[2]}`,
                  url: `https://github.com/${match[1]}/pull/${match[2]}`,
                },
              ]
            : [];
        }),
      ),
    }));
  const archived = sessions.filter((session) => session.archived);
  return [
    {
      id: "sessions",
      title: "Recent agent sessions",
      collapsed: false,
      cards: cards(
        sessions.filter((session) => !session.archived),
        "Recent",
      ),
    },
    ...(archived.length
      ? [{ id: "archived", title: "Archived", collapsed: false, cards: cards(archived, "Archived") }]
      : []),
  ];
}

export function connectionState(
  name: string,
  connected: boolean,
  checked?: { readonly ok: boolean; readonly at: string; readonly needsSignIn?: boolean },
): HealthResponse["connections"][number] {
  return {
    name,
    state:
      !connected || checked?.needsSignIn
        ? "not-connected"
        : checked?.ok === false
          ? "error"
          : checked?.ok
            ? "connected"
            : "unknown",
    checkedAt: checked?.at ? new Date(checked.at).toISOString() : null,
  };
}

/** The Inbox, newest first, split into Today, Yesterday, This week (the 7 days before today) and Earlier, by the Mac's local day. */
export function inboxGroups(
  items: ReadonlyArray<FeedItem>,
  isRead: (item: FeedItem) => boolean = () => false,
  now = new Date(),
): Group[] {
  const label = (at: Date) => dayGroup(at, now);
  return DAY_GROUPS.map((title) => ({
    id: title.toLowerCase().replace(" ", "-"),
    title,
    collapsed: false,
    presentation: "section" as const,
    cards: items
      .filter((item) => label(item.at) === title)
      .flatMap((item): Card[] => {
        const url = webLink(item.url);
        const target = item.source === "linear" ? itemUrlKey(url) : undefined;
        const tickets = [
          ...new Set([
            ...(target?.startsWith("ticket:") ? [target.slice("ticket:".length)] : []),
            ...(item.tickets ?? []).map((ticket) => ticket.id),
          ]),
        ];
        return url
          ? [
              {
                id: item.id,
                kind: "notification",
                feedSource: item.source,
                title: item.title,
                subtitle: item.source === "slack" ? emojiText(item.snippet ?? "") : (item.snippet ?? ""),
                ...(item.calendarEvent ? { calendarEvent: item.calendarEvent } : {}),
                // Saved: why Jev judged the item done, else Jev's "needs you" score beside the reason.
                status: item.done ?? item.reason,
                ...(item.done ? { done: true } : {}),
                ...(item.needsYou === undefined || item.done ? {} : { jev: item.needsYou }),
                url,
                updatedAt: item.at.toISOString(),
                author: item.actor ? people([item.actor], true)[0] : undefined,
                ...(feedTab(item) ? { feedTab: feedTab(item) } : {}),
                unread: !isRead(item),
                attention: [],
                labels: [],
                links: links(item.links ?? []),
                ...(tickets.length ? { rows: ticketRows(tickets) } : {}),
                sessions: [],
                related: [],
              },
            ]
          : [];
      }),
  })).filter((group) => group.cards.length);
}
