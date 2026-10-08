import type { ActivityEntity, ActivityEvent, Card, SectionResponse, Row, ActivitySource } from "./contract";
import { itemUrlKey } from "./linked-items";
import { prReviewDecision, hasPRConflicts, prReviewState } from "./pr-presentation";
import { slackThreadUrl } from "./slack-thread-url";

export const ACTIVITY_VIEWS = ["stream", "trails", "lanes", "attention"] as const;
export type ActivityView = (typeof ACTIVITY_VIEWS)[number];
export const activityView = (value: unknown): ActivityView => ACTIVITY_VIEWS.find((view) => view === value) ?? "stream";
export const activityIdentity = (card: Card) =>
  card.kind === "notification" && card.feedSource && (card.feedSource !== "slack" || card.id !== card.url)
    ? `notification:${card.feedSource}:${card.id}`
    : card.kind === "session" && card.sessions[0]
      ? `session:${card.sessions[0].tool}:${card.sessions[0].id}`
      : card.feedSource === "slack" && card.url
        ? (itemUrlKey(slackThreadUrl(card.url)) ?? card.id)
        : (itemUrlKey(card.url) ?? (card.kind === "issue" ? `ticket:${card.id}` : `${card.kind}:${card.id}`));

function sourceOf(card: Card): ActivitySource {
  return card.kind === "issue"
    ? "linear"
    : card.kind === "scoping"
      ? "notion"
      : card.kind === "session"
        ? (card.sessions[0]?.tool ?? "claude")
        : card.kind === "pr" || card.kind === "review"
          ? "github"
          : (card.feedSource ?? "slack");
}
const base = (id: string, title: string): Card => ({
  id,
  title,
  subtitle: "",
  status: "",
  kind: "notification",
  attention: [],
  labels: [],
  links: [],
  related: [],
  sessions: [],
});
function rowCard(row: Row): Card {
  return {
    ...base(row.kind === "slack" ? row.url : (row.reference ?? row.url), row.title),
    ...row,
    kind:
      row.kind === "pr" ? "pr" : row.kind === "ticket" ? "issue" : row.kind === "notion" ? "scoping" : "notification",
    status: row.status ?? "",
    subtitle: row.subtitle ?? row.reference ?? "",
    feedSource: row.kind === "slack" ? "slack" : undefined,
    priority: row.priority,
    people: row.assignees,
    author: row.owner,
  };
}
/** Flatten normalized provider data without losing direct links or duplicating a shared PR/session. */
export function activityEntities(sections: readonly SectionResponse[]): ActivityEntity[] {
  const entities = new Map<string, ActivityEntity>();
  const fullCards = new Map<string, Card>();
  const add = (card: Card, workIds: readonly string[], full = false) => {
    const id = activityIdentity(card);
    const before = entities.get(id);
    const newer =
      !before ||
      Date.parse(card.updatedAt ?? "") > Date.parse(before.card.updatedAt ?? "") ||
      (!before.card.updatedAt && !!card.updatedAt);
    // Review timestamps are "waiting since", while PR rows use GitHub's last update.
    // Preserve full-card membership/context independently of those source timestamps.
    const previousFull = fullCards.get(id);
    if (full && (!previousFull || card.kind === "review" || previousFull.kind !== "review")) fullCards.set(id, card);
    const context = fullCards.get(id);
    const provider = newer ? card : before.card;
    const current = context
      ? {
          ...provider,
          ...context,
          updatedAt: provider.updatedAt ?? context.updatedAt,
          prState: provider.prState ?? context.prState,
          checks: provider.checks ?? context.checks,
          checksSummary: provider.checksSummary ?? context.checksSummary,
          reviewDecision: provider.reviewDecision ?? context.reviewDecision,
          changes: provider.changes ?? context.changes,
          ...(provider.kind === "session" ? { sessions: provider.sessions } : {}),
        }
      : provider;
    const merged = before
      ? {
          ...before.card,
          ...current,
          rows: current.rows ?? before.card.rows,
          sessions: current.sessions.length ? current.sessions : before.card.sessions,
          badges: current.badges ?? before.card.badges,
        }
      : current;
    entities.set(id, {
      id,
      source: sourceOf(card),
      card: merged,
      workIds: [...new Set([...(before?.workIds ?? []), ...workIds])],
      inCurrentWork: true,
    });
  };
  // Notification actions are event records, never authoritative work state.
  // Sort provider sections so polling order cannot decide which full card wins.
  for (const section of [...sections].sort((a, b) => a.section.localeCompare(b.section)))
    for (const group of section.groups)
      for (const card of group.cards) {
        const self = activityIdentity(card);
        const work =
          card.kind === "issue" || card.kind === "scoping" || card.kind === "pr" || card.kind === "review"
            ? [self]
            : [itemUrlKey(card.url), ...card.links.map((link) => itemUrlKey(link.url))].filter(
                (id): id is string => !!id,
              );
        add(card, work, true);
        for (const row of card.rows ?? []) {
          const related = rowCard(row);
          add(related, row.linkTicketId ? [] : work);
          if (row.kind === "ticket" || row.kind === "notion") {
            // This is a direct connection, not a transitive shared-neighbour inference.
            const before = entities.get(self);
            if (before)
              entities.set(self, { ...before, workIds: [...new Set([...before.workIds, activityIdentity(related)])] });
          }
        }
        for (const session of card.sessions)
          add(
            {
              ...base(session.id, session.title),
              kind: "session",
              updatedAt: session.updatedAt,
              subtitle: session.preview ?? "",
              sessions: [session],
            },
            work,
          );
      }
  return activityWorkLinks([...entities.values()]);
}

/** Resolve a notification/session through its source item to known work, stopping at work roots.
 * Never walk from one ticket through a shared PR to another ticket. */
export function activityWorkLinks(entities: readonly ActivityEntity[]): ActivityEntity[] {
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const isWork = (entity: ActivityEntity) => entity.card.kind === "issue" || entity.card.kind === "scoping";
  return entities.map((entity) => {
    if (isWork(entity)) return entity;
    const workIds = new Set(entity.workIds);
    const visited = new Set<string>([entity.id]);
    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      const linked = byId.get(id);
      if (!linked) return;
      if (isWork(linked)) workIds.add(id);
      else for (const work of linked.workIds) visit(work);
    };
    for (const id of entity.workIds) visit(id);
    return { ...entity, workIds: [...workIds] };
  });
}

/** Attention is derived from current state, never from an old event's title. */
export function activityAttention(entity: ActivityEntity): string[] {
  const card = entity.card;
  if (
    !entity.inCurrentWork ||
    card.done ||
    card.prState === "MERGED" ||
    card.prState === "CLOSED" ||
    (card.kind === "issue" && ["completed", "canceled", "duplicate"].includes(card.statusType ?? ""))
  )
    return [];
  const badges = card.badges ?? [];
  const needs = new Set<string>();
  if (
    badges.some((b) =>
      /^(?:reply|\d+ replies) from |^(?:replied to you|\d+ replies to you)$|^\d+ repl(?:y|ies) waiting/i.test(b.text),
    )
  )
    needs.add("Reply waiting");
  if (card.kind === "pr" || card.kind === "review") {
    if (card.checks === "FAILURE" || card.checks === "ERROR" || (card.checksSummary?.failed ?? 0) > 0)
      needs.add("Checks failed");
    if (hasPRConflicts(badges) || card.conflictFix) needs.add("Merge conflicts");
    if (prReviewState(card.status, badges)) needs.add("Review again");
    if (card.status === "Review requested" || badges.some((badge) => /^needs your review$/i.test(badge.text)))
      needs.add("Review requested");
    else if (
      card.prState !== "DRAFT" &&
      card.kind === "review" &&
      !badges.some((badge) => /^you (?:approved|asked for changes|commented)$/i.test(badge.text)) &&
      prReviewDecision(card.reviewDecision, card.status, badges) !== "APPROVED"
    )
      needs.add("Review requested");
  }
  if (card.kind === "notification" && card.unread) needs.add("Unread");
  for (const attention of card.attention) if (attention.trim()) needs.add(attention);
  return [...needs];
}

/** Local acknowledgement follows meaningful state, not avatar URLs or display-only metadata. */
export const activityAttentionSignature = (entity: ActivityEntity) =>
  JSON.stringify([
    activityAttention(entity),
    entity.card.updatedAt,
    entity.card.status,
    entity.card.prState,
    entity.card.checks,
    entity.card.checksSummary,
    entity.card.reviewDecision,
    (entity.card.badges ?? []).map((badge) => badge.text).sort(),
  ]);

export type ActivityTrail = { root: ActivityEntity; events: ActivityEvent[]; entities: ActivityEntity[] };
/** Only explicit scope-ticket edges form a work component. Shared PRs remain neighbours. */
function workComponents(entities: readonly ActivityEntity[]) {
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const roots = entities.filter((entity) => entity.card.kind === "issue" || entity.card.kind === "scoping");
  const parent = new Map(roots.map((entity) => [entity.id, entity.id]));
  const find = (id: string): string => {
    let current = id;
    while (parent.get(current) && parent.get(current) !== current) current = parent.get(current)!;
    return current;
  };
  for (const entity of roots)
    for (const id of entity.workIds) {
      const other = byId.get(id);
      if (other && parent.has(id) && other.card.kind !== entity.card.kind) parent.set(find(id), find(entity.id));
    }
  return { roots, find };
}
/** Join direct scope-ticket links only; sharing a PR never merges otherwise independent tickets. */
export function activityTrails(
  events: readonly ActivityEvent[],
  entities: readonly ActivityEntity[],
  work?: string,
): ActivityTrail[] {
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const { roots, find } = workComponents(entities);
  const ordered = [...roots].sort(
    (a, b) =>
      Number(b.id === work || b.card.id === work) - Number(a.id === work || a.card.id === work) ||
      Number(b.card.kind === "scoping") - Number(a.card.kind === "scoping") ||
      a.id.localeCompare(b.id),
  );
  const leaders = new Map<string, ActivityEntity>();
  for (const entity of ordered) if (!leaders.has(find(entity.id))) leaders.set(find(entity.id), entity);
  const groups = new Map<string, ActivityTrail>();
  const owners = new Map<string, string>();
  for (const event of events) {
    const entity = byId.get(event.entityId);
    if (!entity) continue;
    let ownerId = owners.get(entity.id);
    if (!ownerId) {
      const connected = entity.workIds.map((id) => leaders.get(find(id))).filter((value) => value !== undefined);
      const owner =
        connected.find((candidate) => candidate.id === work || candidate.card.id === work) ?? connected[0] ?? entity;
      ownerId = owner.id;
      owners.set(entity.id, ownerId);
      const group = groups.get(ownerId) ?? { root: owner, entities: [], events: [] };
      group.entities.push(entity);
      groups.set(ownerId, group);
    }
    groups.get(ownerId)!.events.push(event);
  }
  return [...groups.values()];
}

export type ActivityFilters = {
  query: string;
  sources: readonly ActivitySource[];
  days: number;
  needs: boolean;
  work?: string;
};
/** Calendar dates shared by the picker, filtering and lane axis, including DST days. */
export function activityRange(now: number, days: number) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - days + 1);
  const end = new Date(today);
  end.setDate(end.getDate() + 1);
  return { start: start.getTime(), end: end.getTime() };
}
export function filterActivity(
  events: readonly ActivityEvent[],
  entities: readonly ActivityEntity[],
  filters: ActivityFilters,
  now: number,
) {
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const { start } = activityRange(now, filters.days);
  const query = filters.query.trim().toLocaleLowerCase();
  const matchingWork = new Set<string>();
  if (filters.work) {
    matchingWork.add(filters.work);
    const selected = entities.find((entity) => entity.id === filters.work || entity.card.id === filters.work);
    if (selected) {
      matchingWork.add(selected.id);
      const { roots, find } = workComponents(entities);
      for (const root of roots) if (find(root.id) === find(selected.id)) matchingWork.add(root.id);
    }
  }
  return events
    .filter((event) => {
      const entity = byId.get(event.entityId);
      if (!entity || (filters.sources.length && !filters.sources.includes(entity.source))) return false;
      if (
        filters.work &&
        !matchingWork.has(entity.id) &&
        !matchingWork.has(entity.card.id) &&
        !entity.workIds.some((id) => matchingWork.has(id))
      )
        return false;
      if (filters.needs && !activityAttention(entity).length) return false;
      if (event.occurredAt && Date.parse(event.occurredAt) < start) return false;
      return (
        !query ||
        [
          entity.card.title,
          entity.card.id,
          entity.card.subtitle,
          event.action,
          event.detail ?? "",
          ...entity.workIds.map((id) => byId.get(id)?.card.title ?? id),
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(query)
      );
    })
    .sort(
      (a, b) =>
        (b.occurredAt ? Date.parse(b.occurredAt) : -Infinity) - (a.occurredAt ? Date.parse(a.occurredAt) : -Infinity) ||
        a.id.localeCompare(b.id),
    );
}
