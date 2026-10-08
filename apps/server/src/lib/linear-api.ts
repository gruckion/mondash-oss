import { enabled } from "../profile";
import { Clock, Duration, Effect, Schema } from "effect";
import { Linear, type LinearFailure } from "@/services/linear";
import { ReadOnly, Store, storeKey } from "@/services/store";

/** A Linear issue as the dashboard reads it. */
export const LinearIssue = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  url: Schema.String,
  status: Schema.String,
  statusType: Schema.String,
  // Absent on an unassigned ticket, not null.
  assigneeId: Schema.optional(Schema.NullOr(Schema.String)),
  priority: Schema.Struct({ value: Schema.Finite, name: Schema.String }),
  attachments: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      title: Schema.String,
      subtitle: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  updatedAt: Schema.String,
  labels: Schema.optional(Schema.Array(Schema.String)),
  projectId: Schema.optional(Schema.NullOr(Schema.String)),
  // For Jev's judgement of whether a Scoping doc owns a ticket.
  description: Schema.optional(Schema.NullOr(Schema.String)),
  assignee: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.NullOr(Schema.String)),
  canceledAt: Schema.optional(Schema.NullOr(Schema.String)),
});

// What the dashboard reads of an issue, in one fragment for every query.
const ISSUE_FIELDS = `identifier title url updatedAt createdAt completedAt canceledAt description priority priorityLabel
  state { name type } assignee { id name } labels(first: 20) { nodes { name color } }
  attachments(first: 50) { nodes { url title subtitle } } project { id externalLinks(first: 20) { nodes { url label } } }`;

const Node = Schema.Struct({
  identifier: Schema.String,
  title: Schema.String,
  url: Schema.String,
  updatedAt: Schema.String,
  createdAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
  canceledAt: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  priority: Schema.Finite,
  priorityLabel: Schema.String,
  state: Schema.Struct({ name: Schema.String, type: Schema.String }),
  assignee: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String })),
  labels: Schema.Struct({ nodes: Schema.Array(Schema.Struct({ name: Schema.String, color: Schema.String })) }),
  attachments: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({ url: Schema.String, title: Schema.String, subtitle: Schema.NullOr(Schema.String) }),
    ),
  }),
  project: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      externalLinks: Schema.Struct({
        nodes: Schema.Array(Schema.Struct({ url: Schema.String, label: Schema.String })),
      }),
    }),
  ),
});
type Node = typeof Node.Type;

/** An issue in the shape the rest of the dashboard reads. */
const toIssue = (node: Node): typeof LinearIssue.Type => ({
  id: node.identifier,
  title: node.title,
  url: node.url,
  status: node.state.name,
  statusType: node.state.type,
  assigneeId: node.assignee ? node.assignee.id : null,
  assignee: node.assignee ? node.assignee.name : null,
  priority: { value: node.priority, name: node.priorityLabel },
  attachments: node.attachments.nodes,
  updatedAt: node.updatedAt,
  labels: node.labels.nodes.map((label) => label.name),
  projectId: node.project ? node.project.id : null,
  description: node.description,
  createdAt: node.createdAt,
  completedAt: node.completedAt,
  canceledAt: node.canceledAt,
});

const Comment = Schema.Struct({
  id: Schema.String,
  author: Schema.String,
  createdAt: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  resolvedAt: Schema.NullOr(Schema.String),
});

/** Your open issues with everything the Issues tab shows, from one request. */
export const Mine = Schema.Struct({
  me: Schema.Struct({ id: Schema.String, email: Schema.String }),
  issues: Schema.Array(
    Schema.Struct({
      ...LinearIssue.fields,
      comments: Schema.Array(Comment),
      projectLinks: Schema.Array(Schema.Struct({ url: Schema.String, label: Schema.String })),
    }),
  ),
  /** Label name (lowercased) to its Linear colour. */
  labelColours: Schema.Record(Schema.String, Schema.String),
});
export type Mine = typeof Mine.Type;
export const MINE_KEY = storeKey("linear:mine:v1", Mine);

const MINE_QUERY = `query Mine {
  viewer {
    id email
    assignedIssues(first: 50, filter: { state: { type: { in: ["started", "unstarted", "triage", "backlog"] } } }) {
      nodes { ${ISSUE_FIELDS} comments(last: 50) { nodes { id createdAt resolvedAt parent { id } user { name } } } }
    }
  }
}`;
const MineAnswer = Schema.Struct({
  viewer: Schema.Struct({
    id: Schema.String,
    email: Schema.String,
    assignedIssues: Schema.Struct({
      nodes: Schema.Array(
        Schema.Struct({
          ...Node.fields,
          comments: Schema.Struct({
            nodes: Schema.Array(
              Schema.Struct({
                id: Schema.String,
                createdAt: Schema.String,
                resolvedAt: Schema.NullOr(Schema.String),
                parent: Schema.NullOr(Schema.Struct({ id: Schema.String })),
                user: Schema.NullOr(Schema.Struct({ name: Schema.String })),
              }),
            ),
          }),
        }),
      ),
    }),
  }),
});

const issueKey = (id: string) => storeKey(`linear:issue:v1:${id}`, Schema.NullOr(LinearIssue));
// Your own issues are rewritten each minute by fetchMine, so this ages only other people's.
const ISSUE_FRESH = Duration.minutes(30);
// An ID that names no issue (a stray word such as ISO-8601) almost never becomes one.
const NOT_AN_ISSUE_FRESH = Duration.days(1);

/** Fetches your open issues. Each one also fills its own row, so lookups by ID rarely need a request of their own. */
export const fetchMine = Effect.gen(function* () {
  const linear = yield* Linear;
  const store = yield* Store;
  const { viewer } = yield* linear.query(MINE_QUERY, {}, MineAnswer);
  const issues = viewer.assignedIssues.nodes.map((node) => ({
    ...toIssue(node),
    comments: node.comments.nodes.map((c) => ({
      id: c.id,
      author: c.user ? c.user.name : "Someone",
      createdAt: c.createdAt,
      parentId: c.parent ? c.parent.id : null,
      resolvedAt: c.resolvedAt,
    })),
    projectLinks: node.project ? node.project.externalLinks.nodes : [],
  }));
  yield* Effect.forEach(viewer.assignedIssues.nodes, (node) => store.write(issueKey(node.identifier), toIssue(node)));
  const labelColours = Object.fromEntries(
    viewer.assignedIssues.nodes.flatMap((node) => node.labels.nodes.map((l) => [l.name.toLowerCase(), l.color])),
  );
  return { me: { id: viewer.id, email: viewer.email }, issues, labelColours };
}).pipe(Effect.withSpan("linear.fetchMine"));

/** Your open issues as last stored. The Linear watch (live.ts) refreshes them each minute; this fetches only when none are. */
export const getMine = Effect.gen(function* () {
  if (!enabled("linear")) return { me: { id: "", email: "" }, issues: [], labelColours: {} };
  return yield* (yield* Store).cached(MINE_KEY, Duration.infinity, fetchMine);
});

const ByNumber = Schema.Struct({ issues: Schema.Struct({ nodes: Schema.Array(Node) }) });

/**
 * These issues by ID ("DEMO-4214"), from their rows while fresh, else in one request per team that every row due in
 * this call shares. Each row goes through the store, so concurrent callers share a request and a failed one backs off.
 * Under `ReadOnly` only stored rows answer. Missing from the result: not an issue. A failed request fails the call.
 */
export const issuesById = Effect.fn("linear.issuesById")(function* (ids: ReadonlyArray<string>) {
  if (!enabled("linear")) return new Map<string, typeof LinearIssue.Type>();
  const store = yield* Store;
  const linear = yield* Linear;
  const now = yield* Clock.currentTimeMillis;
  const refs = [...new Set(ids)].flatMap((id) => {
    const match = id.match(/^([A-Z]+)-(\d+)$/);
    return match ? [{ id, team: match[1], number: Number(match[2]) }] : [];
  });
  const rows = yield* Effect.forEach(refs, (ref) => store.read(issueKey(ref.id)));
  const fresh = (row: (typeof rows)[number]) => (row && row.value === null ? NOT_AN_ISSUE_FRESH : ISSUE_FRESH);
  const found = new Map<string, typeof LinearIssue.Type>();
  if (yield* ReadOnly) {
    for (const row of rows) if (row?.value) found.set(row.value.id, row.value);
    return found;
  }
  const due = refs.filter((_, i) => {
    const row = rows[i];
    return !row || now - row.at.getTime() >= Duration.toMillis(fresh(row));
  });
  const batches = new Map<string, Effect.Effect<ReadonlyMap<string, typeof LinearIssue.Type>, LinearFailure>>();
  for (const [team, teamRefs] of Map.groupBy(due, (ref) => ref.team))
    batches.set(
      team,
      yield* Effect.cached(
        linear
          .query(
            `query ByNumber($team: String!, $numbers: [Float!]) {
              issues(first: 100, filter: { team: { key: { eq: $team } }, number: { in: $numbers } }) { nodes { ${ISSUE_FIELDS} } }
            }`,
            { team, numbers: teamRefs.map((ref) => ref.number) },
            ByNumber,
          )
          .pipe(Effect.map(({ issues }) => new Map(issues.nodes.map((node) => [node.identifier, toIssue(node)])))),
      ),
    );
  const issues = yield* Effect.forEach(
    refs,
    (ref, i) => {
      const batch = batches.get(ref.team);
      if (!batch) return Effect.succeed(rows[i]?.value);
      return store.cached(
        issueKey(ref.id),
        fresh(rows[i]),
        batch.pipe(
          Effect.map((got) => {
            const issue = got.get(ref.id);
            return issue === undefined ? null : issue;
          }),
        ),
      );
    },
    { concurrency: "unbounded" },
  );
  for (const issue of issues) if (issue) found.set(issue.id, issue);
  return found;
});

/** One issue by ID, or undefined when Linear has no such issue. */
export const issueById = (id: string) => issuesById([id]).pipe(Effect.map((found) => found.get(id)));

export const LinearNotification = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  title: Schema.String,
  subtitle: Schema.NullOr(Schema.String),
  url: Schema.String,
  category: Schema.String,
  createdAt: Schema.String,
  readAt: Schema.NullOr(Schema.String),
});
export const NOTIFICATIONS_KEY = storeKey("linear:notifications:v2", Schema.Array(LinearNotification));
const Grouped = Schema.Struct({
  notifications: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ ...LinearNotification.fields, groupingKey: Schema.String })),
  }),
});

/**
 * Your Linear inbox, newest first, one entry per group as Linear's inbox shows it (two comments on one ticket are one
 * entry). Callers store it under NOTIFICATIONS_KEY.
 */
export const fetchNotifications = Effect.gen(function* () {
  const answer = yield* (yield* Linear).query(
    `query Notifications {
      notifications(first: 250) { nodes { id type title subtitle url category createdAt readAt groupingKey } }
    }`,
    {},
    Grouped,
  );
  const seen = new Set<string>();
  return answer.notifications.nodes.flatMap(({ groupingKey, ...n }) => {
    if (seen.has(groupingKey)) return [];
    seen.add(groupingKey);
    return [n];
  });
});

const Assignments = Schema.Array(
  Schema.Struct({ subtitle: Schema.NullOr(Schema.String), url: Schema.String, createdAt: Schema.String }),
);
const ASSIGNMENTS_KEY = storeKey("linear:assignments:v1", Assignments);

/** Linear's "assigned you" notifications, for who assigned each ticket; its own query, so other news cannot push them out. */
export const assignmentNotifications = Effect.gen(function* () {
  if (!enabled("linear")) return [];
  const store = yield* Store;
  const linear = yield* Linear;
  return yield* store.cached(
    ASSIGNMENTS_KEY,
    Duration.minutes(5),
    linear
      .query(
        `query Assignments {
          notifications(first: 250, filter: { type: { eq: "issueAssignedToYou" } }) { nodes { subtitle url createdAt } }
        }`,
        {},
        Schema.Struct({ notifications: Schema.Struct({ nodes: Assignments }) }),
      )
      .pipe(Effect.map((answer) => answer.notifications.nodes)),
  );
});

/** Attaches a link (a Slack thread) to an issue, then drops its row so the next read sees it. */
export const attachLink = Effect.fn("linear.attachLink")(function* (id: string, url: string, title: string) {
  const linear = yield* Linear;
  yield* linear.query(
    `mutation AttachLink($id: String!, $url: String!, $title: String) {
      attachmentLinkURL(issueId: $id, url: $url, title: $title) { success }
    }`,
    { id, url, title },
    Schema.Struct({ attachmentLinkURL: Schema.Struct({ success: Schema.Boolean }) }),
  );
  yield* (yield* Store).forget(issueKey(id).name);
});
