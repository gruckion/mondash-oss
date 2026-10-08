"use dom";

import "./activity.css";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { IS_DOM, type DOMProps } from "expo/dom";
import type {
  ActivityEntity,
  ActivityEvent,
  ActivityPreferences,
  ActivityResponse,
  ActivitySource,
  Row,
} from "@mondash/shared/contract";
import {
  activityAttention,
  activityAttentionSignature as signature,
  activityTrails,
  activityRange,
  type ActivityTrail,
  filterActivity,
} from "@mondash/shared/activity";
import { itemUrlKey } from "@mondash/shared/linked-items";
import { slackThreadUrl } from "@mondash/shared/slack-thread-url";
import { SOURCES } from "@mondash/shared/source-icons";
import { checksSvg, prStateSvg } from "@mondash/shared/pr-icons";
import { checksDetails, prReviewDecision } from "@mondash/shared/pr-presentation";
import { linearPriorityIcon } from "@mondash/shared/linear-icons";
import { Metadata } from "./card-metadata";
import { LinkedDocumentRow, PRFooter } from "./card-details";
import { WorkCardIdentity } from "./work-card-identity";
import { PRRowContent } from "./pr-row";
import { OpenUrlContext } from "./ui";

const sourceNames = {
  linear: "Linear",
  github: "GitHub",
  notion: "Notion",
  slack: "Slack",
  claude: "Claude Code",
  codex: "Codex",
};
const day = (date: string) =>
  new Date(date).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const time = (date: string) => new Date(date).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const timestamp = (event: ActivityEvent) =>
  event.occurredAt ? `${day(event.occurredAt)}, ${time(event.occurredAt)}` : "Time unknown";
function threadKey(entity: ActivityEntity) {
  if (!entity.card.url) return entity.id;
  try {
    const url = new URL(slackThreadUrl(entity.card.url));
    const channel = url.pathname.match(/\/archives\/([^/]+)\//)?.[1];
    const thread = url.searchParams.get("thread_ts");
    return channel && thread ? `${url.host}:${channel}:${thread}` : (itemUrlKey(url.href) ?? entity.id);
  } catch {
    return entity.id;
  }
}
function ago(date: string, now: number) {
  const m = Math.round((now - Date.parse(date)) / 60000);
  if (m < 0) return `in ${Math.max(1, Math.round(-m / 60))}h`;
  return m < 1
    ? "just now"
    : m < 60
      ? `${m}m ago`
      : m < 1440
        ? `${Math.floor(m / 60)}h ago`
        : `${Math.floor(m / 1440)}d ago`;
}
function Svg({ value, label }: { value: string; label?: string }) {
  return <img className="act-icon" src={`data:image/svg+xml,${encodeURIComponent(value)}`} alt={label ?? ""} />;
}
function Source({ source }: { source: ActivitySource }) {
  if (source === "linear")
    return <img className="act-icon act-linear" src={require("../../assets/linear-dark.svg")} alt="Linear" />;
  if (source === "claude")
    return <img className="act-icon" src={require("../../assets/claude-symbol.svg")} alt="Claude Code" />;
  if (source === "codex")
    return (
      <span className="act-monochrome">
        <Svg
          value='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m4 17 6-6-6-6M12 19h8"/></svg>'
          label="Codex"
        />
      </span>
    );
  return (
    <span className={source === "slack" ? "act-source" : "act-monochrome"}>
      <Svg value={SOURCES[source]} label={sourceNames[source]} />
    </span>
  );
}
function reference(entity: ActivityEntity) {
  const card = entity.card;
  if (entity.id === "unlinked") return "Unlinked";
  return (
    card.prKey ??
    (/^(?:[A-Z]+-\d+|[^\s:#]+#\d+)$/i.test(card.id)
      ? card.id
      : card.kind === "scoping"
        ? "Scope"
        : sourceNames[entity.source])
  );
}
function documentRow(entity: ActivityEntity): Row {
  const card = entity.card;
  const doc = card.rows?.find((row) => row.kind === "notion" && row.url === card.url);
  return {
    ...doc,
    kind: card.kind === "issue" ? "ticket" : "notion",
    title: card.title,
    url: card.url!,
    status: card.status,
    statusType: card.statusType,
    priority: card.priority,
    priorityValue: card.priorityValue,
    reference: card.kind === "issue" ? reference(entity) : undefined,
    owner: card.author,
    updatedAt: card.updatedAt,
  };
}
function title(event: ActivityEvent, entity: ActivityEntity) {
  if (event.action === "Last updated")
    return entity.source === "linear"
      ? "Issue updated"
      : entity.source === "notion"
        ? "Scope edited"
        : entity.source === "github"
          ? "Pull request updated"
          : "Discussion activity";
  if (event.action === "Change observed") {
    if (/Checks:.*→ (FAILURE|ERROR)/.test(event.detail ?? "")) return "Checks failed";
    return entity.source === "linear"
      ? "Issue changed"
      : entity.source === "notion"
        ? "Scope changed"
        : entity.source === "github"
          ? "Pull request updated"
          : entity.source === "slack"
            ? "Discussion updated"
            : "Session updated";
  }
  if (
    entity.card.kind === "notification" &&
    entity.card.author &&
    !["Meeting", "Created", "Assigned"].includes(event.action)
  )
    return `${entity.card.author.name} ${event.action}`;
  return event.action.charAt(0).toUpperCase() + event.action.slice(1);
}
function snippet(event: ActivityEvent, entity: ActivityEntity) {
  return (
    event.detail ??
    entity.card.sessions[0]?.preview ??
    (Object.values(sourceNames).some((name) => name === entity.card.subtitle) ? "" : entity.card.subtitle)
  );
}
function WorkAuthor({ entity }: { entity: ActivityEntity }) {
  if (entity.card.kind !== "pr" && entity.card.kind !== "review") return null;
  const author = entity.card.author;
  return (
    <span className="act-work-author">
      <span className="act-muted">PR author</span>
      {author?.avatar && <img src={author.avatar} alt="" />}
      <span>{author?.name ?? "Unavailable"}</span>
    </span>
  );
}
function reasonClass(reason: string) {
  return /fail|error/i.test(reason) ? "danger" : /meeting/i.test(reason) ? "meeting" : "warning";
}
function Reasons({ values }: { values: readonly string[] }) {
  return (
    <span className="act-chips">
      {values.map((reason) => (
        <span key={reason} className={`act-chip act-${reasonClass(reason)}`}>
          {reason}
        </span>
      ))}
    </span>
  );
}
function State({ entity, dark }: { entity: ActivityEntity; dark: boolean }) {
  const card = entity.card;
  if (card.kind === "issue" || card.kind === "scoping") {
    const doc =
      card.kind === "scoping" ? card.rows?.find((row) => row.kind === "notion" && row.url === card.url) : undefined;
    const badges =
      card.kind === "scoping"
        ? (card.badges ?? []).filter((badge) => badge.tone === "neutral" && !!badge.people?.length)
        : [];
    return (
      <div className="act-work-metadata">
        <Metadata card={card} badges={badges} doc={doc} />
      </div>
    );
  }
  const greys = { secondary: dark ? "#929298" : "#6b6b73", unreviewed: dark ? "#dadade" : "#323238" };
  const review = prReviewDecision(card.reviewDecision, card.status, card.badges ?? []);
  const checks = checksSvg(card.checks, card.checksSummary, review, greys);
  return (
    <div className="act-state">
      {card.prState && (
        <span className="act-chip">
          <Svg value={prStateSvg(card.prState, greys)} />
          {card.prState.toLowerCase()}
        </span>
      )}
      {!!card.status && <span className="act-chip">{card.status}</span>}
      {checks && (
        <span className="act-chip" title={checksDetails(card.checks, card.checksSummary, review).join(" · ")}>
          <Svg value={checks} />
          {card.checks?.toLowerCase().replaceAll("_", " ") ?? "Review"}
        </span>
      )}
      {card.priority && (
        <span className="act-chip">
          <Svg
            value={linearPriorityIcon({
              priority: {
                name: card.priority,
                value: card.priorityValue ?? { Urgent: 1, High: 2, Medium: 3, Low: 4 }[card.priority] ?? 0,
              },
            })}
          />
          {card.priority}
        </span>
      )}
      {card.people?.length ? (
        <span className="act-chip">{card.people.map((person) => person.name).join(", ")}</span>
      ) : null}
      {card.labels.map((label) => (
        <span key={label} className="act-chip">
          {label}
        </span>
      ))}
      {card.changes && (
        <span className="act-chip">
          <span className="act-green">+{card.changes.additions.toLocaleString()}</span>
          <span className="act-red">−{card.changes.deletions.toLocaleString()}</span>
          {card.changes.files} files
        </span>
      )}
    </div>
  );
}

/** All four views keep their own scroll position and use the same events, filters and selection. */
export default function ActivityContent(props: {
  data: ActivityResponse;
  preferences: ActivityPreferences;
  dark: boolean;
  width: number;
  active: boolean;
  changePreferences: (patch: Partial<ActivityPreferences>) => Promise<void>;
  openOptions: (panel: "filter" | "display" | "range") => Promise<void>;
  openSource: (url: string) => Promise<void>;
  openSession: (tool: "claude" | "codex", id: string) => Promise<void>;
  dom?: DOMProps;
}) {
  const { data, preferences: p, dark } = props;
  const [limit, setLimit] = useState(200);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [trailLimits, setTrailLimits] = useState<Record<string, number>>({});
  const [expandedTrails, setExpandedTrails] = useState<string[]>([]);
  const [cluster, setCluster] = useState<string | null>(null);
  const [compact, setCompact] = useState(props.width < 1000);
  const root = useRef<HTMLDivElement>(null);
  const axis = useRef<HTMLDivElement>(null);
  const [axisWidth, setAxisWidth] = useState(0);
  const positionedRange = useRef("");
  const update = (patch: Partial<ActivityPreferences>) => {
    void props.changePreferences(patch).catch(() => setNotice("View preferences could not be saved."));
  };
  const action = async (run: () => Promise<void>) => {
    setBusy(true);
    setNotice("");
    try {
      await run();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The action could not be completed.");
    } finally {
      setBusy(false);
    }
  };
  useLayoutEffect(() => {
    if (IS_DOM) {
      document.body.style.margin = "0";
      document.documentElement.style.height = "100%";
      document.body.style.height = "100%";
    }
    if (!root.current) return;
    const observer = new ResizeObserver(([entry]) => setCompact(entry.contentRect.width < 1000));
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (!axis.current) return;
    const observer = new ResizeObserver(([entry]) => setAxisWidth(entry.contentRect.width));
    observer.observe(axis.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!compact || !p.selected) return;
    const previous = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLButtonElement>(".act-close")?.focus();
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [compact, p.selected]);
  const now = Date.parse(data.generatedAt);
  const byId = useMemo(() => new Map(data.entities.map((entity) => [entity.id, entity])), [data.entities]);
  const events = useMemo(() => filterActivity(data.events, data.entities, p, Date.parse(data.generatedAt)), [data, p]);
  const latest = useMemo(() => {
    const result = new Map<string, ActivityEvent>();
    for (const event of events) if (!result.has(event.entityId)) result.set(event.entityId, event);
    return result;
  }, [events]);
  const trails = useMemo(() => {
    const all = activityTrails(events, data.entities, p.work);
    const linked = all.filter((trail) => trail.root.card.kind === "issue" || trail.root.card.kind === "scoping");
    const other = all.filter((trail) => !linked.includes(trail));
    if (!other.length) return linked;
    const unlinked: ActivityTrail = {
      root: {
        id: "unlinked",
        source: "github",
        workIds: [],
        inCurrentWork: true,
        card: {
          id: "unlinked",
          kind: "notification",
          title: "Not linked to a work item",
          subtitle: "No confirmed work link",
          status: "",
          attention: [],
          labels: [],
          links: [],
          related: [],
          sessions: [],
        },
      },
      entities: other.flatMap((trail) => trail.entities),
      events: other
        .flatMap((trail) => trail.events)
        .sort(
          (a, b) =>
            (b.occurredAt ? Date.parse(b.occurredAt) : -Infinity) -
            (a.occurredAt ? Date.parse(a.occurredAt) : -Infinity),
        ),
    };
    return [...linked, unlinked];
  }, [events, data.entities, p.work]);
  const rawNeeds = [...latest.keys()]
    .map((id) => byId.get(id)!)
    .filter((entity) => activityAttention(entity).length && p.handled[entity.id] !== signature(entity));
  const attentionOwner = (entity: ActivityEntity) =>
    entity.card.kind === "notification"
      ? (entity.workIds.find((id) => {
          const work = byId.get(id);
          return work && work.source === entity.source && work.card.kind !== "notification";
        }) ?? entity.id)
      : entity.id;
  const attentionGroups = new Map<string, ActivityEntity[]>();
  for (const entity of rawNeeds) {
    const id = attentionOwner(entity);
    attentionGroups.set(id, [...(attentionGroups.get(id) ?? []), entity]);
  }
  const needs = [...attentionGroups.values()].map(
    (group) => group.find((entity) => entity.card.kind === "notification") ?? group[0],
  );
  const selected = data.events.find((event) => event.id === p.selected);
  const selectedEntity = selected ? byId.get(selected.entityId) : undefined;
  const select = (event: ActivityEvent) => update({ selected: event.id });
  const linked = (entity: ActivityEntity) =>
    entity.workIds
      .map((id) => byId.get(id))
      .filter((item): item is ActivityEntity => !!item && item.id !== entity.id && item.card.kind !== "notification");
  const workEntity = (entity: ActivityEntity) =>
    entity.card.kind === "notification"
      ? (linked(entity).find((item) => item.source === entity.source) ?? entity)
      : entity;
  const openEntity = (entity: ActivityEntity) => {
    const event =
      latest.get(entity.id) ??
      data.events.find((event) => event.entityId === entity.id) ??
      (entity.id === "unlinked" ? trails.find((trail) => trail.root.id === "unlinked")?.events[0] : undefined);
    if (event) select(event);
    else if (entity.card.url) void action(() => props.openSource(entity.card.url!));
  };
  const workCard = (entity: ActivityEntity) => {
    const card = entity.card;
    const onOpen = card.url ? () => void action(() => props.openSource(card.url!)) : undefined;
    if (card.kind === "issue" || card.kind === "scoping") return <WorkCardIdentity card={card} onOpen={onOpen} />;
    if (card.kind === "pr" || card.kind === "review") {
      const badges = card.badges ?? [];
      return (
        <PRRowContent
          title={card.title === reference(entity) && card.subtitle ? card.subtitle : card.title}
          reference={reference(entity)}
          url={card.url}
          onOpen={onOpen}
          state={
            card.prState ??
            (card.status.toUpperCase() === "MERGED"
              ? "MERGED"
              : card.status.toUpperCase() === "CLOSED"
                ? "CLOSED"
                : card.status.toUpperCase() === "DRAFT" || badges.some((badge) => badge.text === "draft")
                  ? "DRAFT"
                  : "OPEN")
          }
          updatedAt={card.updatedAt}
          checks={card.checks}
          summary={card.checksSummary}
          stack={card.stack}
          aiCheckFailures={card.aiCheckFailures}
          changes={card.changes}
          status={card.status}
          reviewDecision={card.reviewDecision}
          badges={badges}
          author={card.author}
          footer={<PRFooter badges={badges} />}
        />
      );
    }
    return (
      <button className="act-related" onClick={() => openEntity(entity)}>
        <span className="act-work-heading">
          <Source source={entity.source} />
          <strong>{card.title}</strong>
        </span>
        <span className="act-muted">{reference(entity)}</span>
        <State entity={entity} dark={dark} />
      </button>
    );
  };
  const links = (entity: ActivityEntity) =>
    !p.hidden?.includes("links") && (
      <div className="act-linked-work">
        {linked(entity)
          .slice(0, 4)
          .map((item) =>
            (item.card.kind === "issue" || item.card.kind === "scoping") && item.card.url ? (
              <LinkedDocumentRow
                key={item.id}
                row={documentRow(item)}
                onOpen={() => void action(() => props.openSource(item.card.url!))}
              />
            ) : (
              <span className="act-linked-chips" key={item.id}>
                <button title={item.card.title} onClick={() => openEntity(item)}>
                  <Source source={item.source} />
                  <span>{reference(item) === "Scope" ? item.card.title : reference(item)}</span>
                </button>
              </span>
            ),
          )}
      </div>
    );
  const reasons = (entity: ActivityEntity) => {
    const owner = byId.get(attentionOwner(entity)) ?? entity;
    const members = attentionGroups.get(attentionOwner(entity)) ?? [entity];
    const values = [...new Set([owner, ...members].flatMap((item) => activityAttention(item)))];
    if (entity.card.calendarEvent) {
      return [`Meeting ${time(entity.card.calendarEvent.startsAt)}`, ...values.filter((value) => value !== "Unread")];
    }
    return values.sort((a, b) => Number(reasonClass(b) === "danger") - Number(reasonClass(a) === "danger"));
  };
  const eventRow = (event: ActivityEvent, chronology = false, trail = false) => {
    const entity = byId.get(event.entityId)!;
    return (
      <div
        key={event.id}
        className={`act-event ${p.selected === event.id ? "selected" : ""} ${chronology ? "chronology" : ""} ${trail ? "trail-event" : ""}`}
      >
        <span className="act-clock">
          {event.occurredAt ? time(event.occurredAt) : "—"}
          {trail && event.occurredAt && <small>{ago(event.occurredAt, now)}</small>}
        </span>
        {chronology && <span className={`act-timeline-dot act-${reasonClass(reasons(entity)[0] ?? "")}`} />}
        <div className="act-entry">
          <button className="act-entry-main" onClick={() => select(event)}>
            <span className="act-entry-title">
              <Source source={entity.source} />
              <strong>{title(event, entity)}</strong>
            </span>
            <span className="act-muted act-context-title">
              {entity.card.title} · {reference(entity)}
            </span>
            <WorkAuthor entity={workEntity(entity)} />
            {!p.hidden?.includes("snippets") && snippet(event, entity) && (
              <span className="act-snippet">{snippet(event, entity)}</span>
            )}
          </button>
          <div className="act-entry-meta">
            <Reasons values={reasons(entity)} />
            {links(entity)}
          </div>
        </div>
        <span className="act-age">
          {event.occurredAt ? ago(event.occurredAt, now) : "Undated"}
          {event.timeBasis === "observed" && <small>Observed</small>}
        </span>
      </div>
    );
  };
  const stream = (list: readonly ActivityEvent[], chronology = false) => {
    let previous = "";
    return list.slice(0, limit).map((event) => {
      const label = event.occurredAt ? day(event.occurredAt) : "No time supplied";
      const heading = label !== previous;
      previous = label;
      return (
        <div key={event.id}>
          {heading && (
            <h3 className="act-day">
              {event.occurredAt && new Date(event.occurredAt).toDateString() === new Date(now).toDateString() ? (
                <>
                  <strong>Today</strong>
                  <span>{label}</span>
                </>
              ) : (
                label
              )}
            </h3>
          )}
          {eventRow(event, chronology)}
        </div>
      );
    });
  };
  const more = events.length > limit && (
    <button className="act-more" onClick={() => setLimit((value) => value + 200)}>
      Show more activity
    </button>
  );
  const { start, end: dayEnd } = activityRange(now, p.days);
  const meetingEnds = events
    .map((event) => byId.get(event.entityId)?.card.calendarEvent?.endsAt)
    .filter((date): date is string => !!date)
    .map((date) => Date.parse(date));
  const end = Math.max(dayEnd, ...meetingEnds);
  const position = (value: number) => `${Math.max(1, Math.min(99, ((value - start) / (end - start)) * 100))}%`;
  const hour = 60 * 60 * 1000;
  const dayTicks: number[] = [];
  for (const date = new Date(start); date.getTime() < end; date.setDate(date.getDate() + 1)) {
    dayTicks.push(date.getTime());
  }
  const hourTicks =
    p.days <= 7 ? Array.from({ length: Math.ceil((end - start) / hour) }, (_, index) => start + index * hour) : [];
  const labelEvery = p.days === 1 ? 1 : p.days <= 3 ? 3 : 6;
  const dayLabelEvery = Math.ceil(dayTicks.length / 7);
  const trackMinimum =
    p.days <= 7 ? ((end - start) / hour) * (p.days === 1 ? 44 : p.days <= 3 ? 24 : 14) : dayTicks.length * 48;
  const fraction = (value: number) => Math.max(0, Math.min(1, (value - start) / (end - start)));
  const timelinePosition = (value: number) => `${fraction(value) * 100}%`;
  useLayoutEffect(() => {
    const range = `${start}:${end}`;
    if (p.view !== "lanes" || !axisWidth || positionedRange.current === range) return;
    const scroll = axis.current?.closest<HTMLElement>(".act-lane-scroll");
    if (!scroll) return;
    scroll.scrollLeft = Math.max(
      0,
      (compact ? 160 : 240) +
        Math.max(0, Math.min(1, (now - start) / (end - start))) * axisWidth -
        scroll.clientWidth * 0.7,
    );
    positionedRange.current = range;
  }, [p.view, start, end, axisWidth, compact, now]);
  const latestSession = [...latest.keys()]
    .map((id) => byId.get(id)!)
    .find((entity) => entity.card.kind === "session" && entity.card.sessions.length);
  const resume = (entity: ActivityEntity, banner = false) => {
    const session = entity.card.sessions[0];
    return (
      session && (
        <div className={`act-resume ${banner ? "banner" : ""}`}>
          <Source source={entity.source} />
          <div>
            {banner && <small>WHERE YOU LEFT OFF</small>}
            <strong>{session.title}</strong>
            <span className="act-muted">
              {sourceNames[session.tool]} · {session.updatedAt ? ago(session.updatedAt, now) : "Time unknown"}
              {session.preview ? ` · ${session.preview}` : ""}
            </span>
          </div>
          <button
            className="act-primary"
            disabled={busy}
            onClick={() => void action(() => props.openSession(session.tool, session.id))}
          >
            Open session
          </button>
        </div>
      )
    );
  };
  const currentEntity = selectedEntity ? workEntity(selectedEntity) : undefined;
  const related = selectedEntity
    ? data.entities.filter(
        (entity) =>
          entity.id !== selectedEntity.id &&
          entity.id !== currentEntity?.id &&
          entity.card.kind !== "notification" &&
          (selectedEntity.workIds.includes(entity.id) ||
            entity.workIds.includes(selectedEntity.id) ||
            selectedEntity.workIds.some((id) => entity.workIds.includes(id))),
      )
    : [];
  const history = selectedEntity
    ? [...data.events]
        .filter((event) => event.entityId === (currentEntity ?? selectedEntity).id)
        .sort(
          (a, b) =>
            (b.occurredAt ? Date.parse(b.occurredAt) : -Infinity) -
            (a.occurredAt ? Date.parse(a.occurredAt) : -Infinity),
        )
    : [];
  const showInspector = !!selectedEntity || (!compact && ["attention", "lanes", "stream"].includes(p.view));
  const filterIcon =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 6h18M7 12h10M10 18h4"/></svg>';
  const displayIcon =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 8h8M17 8h4M3 16h4M13 16h8"/><circle cx="14" cy="8" r="3"/><circle cx="10" cy="16" r="3"/></svg>';
  return (
    <OpenUrlContext.Provider value={(url) => action(() => props.openSource(url))}>
      <div
        ref={root}
        className={`activity-content ${dark ? "dark" : "light"} ${compact ? "compact" : ""}`}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            update({ selected: null });
            setCluster(null);
          }
        }}
      >
        <div className="act-toolbar" inert={compact && !!selectedEntity}>
          <label className="act-search">
            <span aria-hidden="true">⌕</span>
            <input
              type="search"
              aria-label="Search activity"
              placeholder="Search activity…"
              value={p.query}
              onChange={(event) => update({ query: event.target.value })}
            />
          </label>
          <div className="act-range" aria-label="Time range">
            {([1, 3, 7] as const).map((days) => (
              <button key={days} aria-pressed={p.days === days} onClick={() => update({ days })}>
                {days === 1 ? "Today" : `${days} days`}
              </button>
            ))}
            <button
              aria-label="More time ranges"
              aria-pressed={p.days > 7}
              onClick={() => void action(() => props.openOptions("range"))}
            >
              {p.days > 7 ? `${p.days} days` : "⌄"}
            </button>
          </div>
          <span className="act-toolbar-summary">
            {p.needs ? "Needs me" : p.sources.length ? `${p.sources.length} sources` : "All activity"} · {events.length}{" "}
            events
          </span>
          <button
            className={`act-control ${p.sources.length || p.needs ? "active" : ""}`}
            aria-label="Sort and filter activity"
            title="Filter sources and attention"
            onClick={() => void action(() => props.openOptions("filter"))}
          >
            <Svg value={filterIcon} />
          </button>
          <button
            className={`act-control ${p.hidden?.length ? "active" : ""}`}
            aria-label="Activity display options"
            title="Display"
            onClick={() => void action(() => props.openOptions("display"))}
          >
            <Svg value={displayIcon} />
          </button>
        </div>
        {p.work && (
          <div className="act-context" inert={compact && !!selectedEntity}>
            <span>
              Activity for <strong>{byId.get(p.work)?.card.title ?? p.work}</strong>
            </span>
            <button onClick={() => update({ work: "" })}>Show all work ×</button>
          </div>
        )}
        {notice && (
          <div className="act-notice" role="status">
            {notice}
          </div>
        )}
        <div className={`act-main ${showInspector ? "has-inspector" : ""}`}>
          <div className="act-views" inert={compact && !!selectedEntity}>
            <section className="act-view" aria-label="Activity stream" hidden={p.view !== "stream"}>
              {stream(events)}
              {more}
            </section>
            <section className="act-view act-trails-view" aria-label="Work trails" hidden={p.view !== "trails"}>
              {trails.map((trail) => {
                const session = trail.entities.find((entity) => entity.card.kind === "session");
                const attention = trail.entities.filter(
                  (entity) => activityAttention(entity).length && p.handled[entity.id] !== signature(entity),
                ).length;
                const counts = {
                  pr: trail.entities.filter(
                    (entity) => entity.source === "github" && entity.card.kind !== "notification",
                  ).length,
                  thread: new Set(trail.entities.filter((entity) => entity.source === "slack").map(threadKey)).size,
                  session: trail.entities.filter((entity) => entity.card.kind === "session").length,
                };
                const expanded = expandedTrails.includes(trail.root.id);
                return (
                  <article className="act-trail" key={trail.root.id}>
                    <div className="act-trail-top">
                      <span>
                        Last activity {trail.events[0]?.occurredAt ? ago(trail.events[0].occurredAt, now) : "unknown"}
                      </span>
                      {attention > 0 && <Reasons values={[`${attention} ${attention === 1 ? "needs" : "need"} you`]} />}
                      <span className="act-trail-counts">
                        {counts.pr} PRs · {counts.thread} threads · {counts.session} sessions
                      </span>
                    </div>
                    <button className="act-work-heading" onClick={() => openEntity(trail.root)}>
                      <Source source={trail.root.source} />
                      <strong>{trail.root.card.title}</strong>
                      <span className="act-muted">{reference(trail.root)}</span>
                    </button>
                    <WorkAuthor entity={trail.root} />
                    {trail.root.id !== "unlinked" && <State entity={trail.root} dark={dark} />}
                    <div className="act-mini-timeline">
                      <div className="act-mini-line" />
                      {trail.events
                        .filter((event) => event.occurredAt)
                        .map((event) => (
                          <button
                            key={event.id}
                            className={`act-mini-dot act-${reasonClass(reasons(byId.get(event.entityId)!)[0] ?? "")}`}
                            style={{ left: position(Date.parse(event.occurredAt!)) }}
                            onClick={() => select(event)}
                            aria-label={`${title(event, byId.get(event.entityId)!)}, ${timestamp(event)}`}
                          />
                        ))}
                      <span>{day(new Date(start).toISOString())}</span>
                      <span>Now</span>
                    </div>
                    <div>
                      {trail.events
                        .slice(0, expanded ? (trailLimits[trail.root.id] ?? 200) : 3)
                        .map((event) => eventRow(event, false, true))}
                    </div>
                    {expanded && trail.events.length > (trailLimits[trail.root.id] ?? 200) && (
                      <button
                        className="act-more"
                        onClick={() =>
                          setTrailLimits((before) => ({
                            ...before,
                            [trail.root.id]: (before[trail.root.id] ?? 200) + 200,
                          }))
                        }
                      >
                        Show more events · {trail.events.length - (trailLimits[trail.root.id] ?? 200)} remaining
                      </button>
                    )}
                    <div className="act-trail-bottom">
                      <button
                        className="act-secondary"
                        onClick={() =>
                          setExpandedTrails((before) =>
                            expanded ? before.filter((id) => id !== trail.root.id) : [...before, trail.root.id],
                          )
                        }
                      >
                        {expanded ? "Less history" : `Full history · ${trail.events.length} events`}
                      </button>
                      {session && resume(session)}
                    </div>
                  </article>
                );
              })}
            </section>
            <section className="act-view act-timeline-view" aria-label="Timeline" hidden={p.view !== "lanes"}>
              <div className="act-lane-scroll">
                <div className="act-lanes" style={{ minWidth: trackMinimum + (compact ? 224 : 324) }}>
                  <div className="act-lane-header">
                    <span>Work item{p.days === 1 && <small>{day(new Date(start).toISOString())}</small>}</span>
                    <div className="act-track" ref={axis}>
                      {dayTicks
                        .filter((_, index) => index % dayLabelEvery === 0)
                        .map((tick) => (
                          <span className="act-tick act-date-tick" key={tick} style={{ left: timelinePosition(tick) }}>
                            {new Date(tick).toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}
                          </span>
                        ))}
                      {hourTicks
                        .filter((tick) => new Date(tick).getHours() % labelEvery === 0)
                        .map((tick) => (
                          <span
                            className="act-tick act-hour-tick"
                            data-start={tick === start}
                            key={tick}
                            style={{ left: timelinePosition(tick) }}
                            title={new Date(tick).toLocaleString()}
                          >
                            {time(new Date(tick).toISOString())}
                          </span>
                        ))}
                      <span className="act-now-label" style={{ left: timelinePosition(now) }}>
                        Now · {time(new Date(now).toISOString())}
                      </span>
                    </div>
                    <span>No time</span>
                  </div>
                  {trails.map((trail) => {
                    const buckets = new Map<number, ActivityEvent[]>();
                    for (const event of trail.events.filter((event) => event.occurredAt)) {
                      const bucket = Math.floor(
                        fraction(Date.parse(event.occurredAt!)) * Math.max(1, Math.floor(axisWidth / 32)),
                      );
                      buckets.set(bucket, [...(buckets.get(bucket) ?? []), event]);
                    }
                    const undated = trail.events.filter((event) => !event.occurredAt);
                    return (
                      <div className="act-lane" key={trail.root.id}>
                        <button className="act-lane-title" onClick={() => openEntity(trail.root)}>
                          <span className="act-muted">{reference(trail.root)}</span>
                          <strong>
                            <Source source={trail.root.source} />
                            {trail.root.card.title}
                          </strong>
                          {trail.entities
                            .filter(
                              (entity) =>
                                (entity.card.kind === "issue" || entity.card.kind === "scoping") &&
                                entity.id !== trail.root.id,
                            )
                            .map((entity) => (
                              <span className="act-lane-linked" key={entity.id}>
                                <Source source={entity.source} />
                                {entity.card.title}
                              </span>
                            ))}
                        </button>
                        <div className="act-track">
                          {hourTicks.map((tick) => (
                            <span
                              className="act-grid-line act-hour-line"
                              key={`hour:${tick}`}
                              style={{ left: timelinePosition(tick) }}
                              aria-hidden="true"
                            />
                          ))}
                          {dayTicks.map((tick) => (
                            <span
                              className="act-grid-line act-day-line"
                              key={`day:${tick}`}
                              style={{ left: timelinePosition(tick) }}
                              aria-hidden="true"
                            />
                          ))}
                          <span className="act-now" style={{ left: timelinePosition(now) }} />
                          {[...buckets].map(([bucket, list]) => {
                            const visible = list.length > 4 ? list.slice(0, 3) : list;
                            const clusterId = `${trail.root.id}:${bucket}`;
                            return (
                              <div
                                key={bucket}
                                className="act-point-stack"
                                style={{ left: timelinePosition(Date.parse(list[0].occurredAt!)) }}
                              >
                                {visible.map((event) => {
                                  const entity = byId.get(event.entityId)!;
                                  const actionable = reasons(entity).length > 0;
                                  return (
                                    <button
                                      key={event.id}
                                      style={{
                                        transform: `translateX(${(fraction(Date.parse(event.occurredAt!)) - fraction(Date.parse(list[0].occurredAt!))) * axisWidth}px)`,
                                      }}
                                      className={`act-point ${actionable ? `act-ring-${reasonClass(reasons(entity)[0])}` : ""} ${p.selected === event.id ? "selected" : ""}`}
                                      aria-label={`${title(event, entity)}, ${entity.card.title}, ${timestamp(event)}`}
                                      title={`${title(event, entity)} · ${entity.card.title}\n${timestamp(event)}`}
                                      onClick={() => select(event)}
                                    >
                                      <Source source={entity.source} />
                                    </button>
                                  );
                                })}
                                {list.length > 4 && (
                                  <button
                                    className="act-cluster"
                                    aria-expanded={cluster === clusterId}
                                    aria-label={`${list.length - 3} more events for ${trail.root.card.title}`}
                                    onClick={() => setCluster(cluster === clusterId ? null : clusterId)}
                                  >
                                    +{list.length - 3}
                                  </button>
                                )}
                                {cluster === clusterId && (
                                  <div className="act-cluster-menu">
                                    <button className="act-cluster-close" onClick={() => setCluster(null)}>
                                      Close
                                    </button>
                                    {list.map((event) => (
                                      <button
                                        key={event.id}
                                        onClick={() => {
                                          select(event);
                                          setCluster(null);
                                        }}
                                      >
                                        <Source source={byId.get(event.entityId)!.source} />
                                        <span>
                                          {title(event, byId.get(event.entityId)!)}
                                          <small>{timestamp(event)}</small>
                                        </span>
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                          {trail.events
                            .filter((event) => event.action === "Meeting")
                            .map((event) => {
                              const meeting = byId.get(event.entityId)!.card.calendarEvent;
                              return (
                                meeting?.endsAt && (
                                  <button
                                    key={`meeting:${event.id}`}
                                    className="act-meeting-bar"
                                    style={{
                                      left: timelinePosition(Date.parse(meeting.startsAt)),
                                      width: `${Math.max(1, ((Date.parse(meeting.endsAt) - Date.parse(meeting.startsAt)) / (end - start)) * 100)}%`,
                                    }}
                                    aria-label="Open meeting"
                                    onClick={() => select(event)}
                                  />
                                )
                              );
                            })}
                        </div>
                        <div className="act-undated">
                          {undated.length > 0 && (
                            <button onClick={() => select(undated[0])}>{undated.length} undated</button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              <p className="act-help act-muted">
                ● One point per recorded event · Coloured ring: needs you · Blue bar: meeting with a known start and end
              </p>
            </section>
            <section className="act-view" aria-label="Attention" hidden={p.view !== "attention"}>
              {latestSession && resume(latestSession, true)}
              <div className="act-section-heading">
                <h2>{needs.length} need you</h2>
                <span className="act-muted">Replies, reviews, failed checks, conflicts and new activity</span>
              </div>
              {needs.length === 0 && <p className="act-muted">Nothing needs you in this selection.</p>}
              <div className="act-attention-grid">
                {needs.map((entity) => {
                  const event = latest.get(entity.id)!;
                  return (
                    <article key={entity.id} className={`act-attention ${p.selected === event.id ? "selected" : ""}`}>
                      <div className="act-attention-top">
                        <Reasons values={reasons(entity)} />
                        <span className="act-muted">
                          {event.occurredAt ? ago(event.occurredAt, now) : "Time unknown"}
                        </span>
                      </div>
                      <button className="act-entry-main" onClick={() => select(event)}>
                        <span className="act-entry-title">
                          <Source source={entity.source} />
                          <strong>{title(event, entity)}</strong>
                        </span>
                        <span className="act-muted">
                          {entity.card.title} · {reference(entity)}
                        </span>
                        <WorkAuthor entity={workEntity(entity)} />
                        {!p.hidden?.includes("snippets") && snippet(event, entity) && (
                          <span className="act-snippet">{snippet(event, entity)}</span>
                        )}
                      </button>
                      {links(entity)}
                      <div className="act-card-actions">
                        <button className="act-secondary" onClick={() => update({ view: "lanes", selected: event.id })}>
                          Show in timeline
                        </button>
                        <button className="act-secondary" onClick={() => select(event)}>
                          Details
                        </button>
                        <button
                          className="act-handle"
                          onClick={() =>
                            update({
                              handled: {
                                ...p.handled,
                                ...Object.fromEntries(
                                  (attentionGroups.get(attentionOwner(entity)) ?? [entity]).map((item) => [
                                    item.id,
                                    signature(item),
                                  ]),
                                ),
                              },
                            })
                          }
                        >
                          Mark handled
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
              {Object.keys(p.handled).length > 0 && (
                <button className="act-more" onClick={() => update({ handled: {} })}>
                  Undo handled items
                </button>
              )}
              <div className="act-section-heading">
                <h2>Timeline</h2>
                <span className="act-muted">All activity · actionable events are marked in place</span>
              </div>
              {stream(events, true)}
              {more}
            </section>
            {events.length === 0 && (
              <div className="act-empty">
                <h2>{data.events.length ? "No activity matches" : "Your activity history starts here"}</h2>
                <p>Connected work appears after its next update. Try a wider time range or clear the filters.</p>
                <button
                  className="act-secondary"
                  onClick={() => update({ query: "", sources: [], needs: false, work: "", days: 90 })}
                >
                  Clear filters
                </button>
              </div>
            )}
          </div>
          {compact && selectedEntity && (
            <button className="act-scrim" aria-label="Close event details" onClick={() => update({ selected: null })} />
          )}
          {showInspector && (
            <aside
              className={`act-inspector ${!selectedEntity ? "empty" : ""}`}
              aria-label="Event details"
              role={compact ? "dialog" : "complementary"}
              aria-modal={compact || undefined}
              onKeyDown={(event) => {
                if (compact && event.key === "Tab") {
                  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
                  const first = buttons[0],
                    last = buttons[buttons.length - 1];
                  if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last?.focus();
                  } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first?.focus();
                  }
                }
              }}
            >
              {selected && selectedEntity && currentEntity ? (
                <>
                  <div className="act-inspector-heading">
                    <Source source={selectedEntity.source} />
                    <div>
                      <h2>{title(selected, selectedEntity)}</h2>
                      <span className="act-muted">
                        {timestamp(selected)}
                        {selected.occurredAt ? ` · ${ago(selected.occurredAt, now)}` : ""}
                      </span>
                      {selectedEntity.card.kind === "notification" && selectedEntity.card.author && (
                        <span className="act-muted">By {selectedEntity.card.author.name}</span>
                      )}
                    </div>
                    <button
                      className="act-close"
                      aria-label="Close event details"
                      onClick={() => update({ selected: null })}
                    >
                      ×
                    </button>
                  </div>
                  <Reasons values={reasons(selectedEntity)} />
                  {selected.detail && <p className="act-snippet">{selected.detail}</p>}
                  {selected.timeBasis === "observed" && (
                    <p className="act-muted act-time-note">
                      Observed by Mondash; the source did not provide an event time.
                    </p>
                  )}
                  {snippet(selected, selectedEntity) && !selected.detail && !p.hidden?.includes("snippets") && (
                    <p className="act-snippet">{snippet(selected, selectedEntity)}</p>
                  )}
                  <h3>Current state · {sourceNames[currentEntity.source]}</h3>
                  {currentEntity.card.kind === "issue" ||
                  currentEntity.card.kind === "scoping" ||
                  currentEntity.card.kind === "pr" ||
                  currentEntity.card.kind === "review" ? (
                    <div className="act-current-work">
                      {workCard(currentEntity)}
                      {!currentEntity.inCurrentWork && <span className="act-muted">Last recorded state</span>}
                    </div>
                  ) : (
                    <div className="act-current">
                      <div className="act-work-heading">
                        <Source source={currentEntity.source} />
                        <strong>{currentEntity.card.title}</strong>
                      </div>
                      <span className="act-muted">
                        {reference(currentEntity)}
                        {!currentEntity.inCurrentWork ? " · Last recorded state" : ""}
                      </span>
                      <WorkAuthor entity={currentEntity} />
                      <State entity={currentEntity} dark={dark} />
                      {currentEntity.card.calendarEvent && (
                        <Reasons
                          values={[
                            `${time(currentEntity.card.calendarEvent.startsAt)}${currentEntity.card.calendarEvent.endsAt ? `–${time(currentEntity.card.calendarEvent.endsAt)}` : ""} · ${day(currentEntity.card.calendarEvent.startsAt)}`,
                          ]}
                        />
                      )}
                    </div>
                  )}
                  {selectedEntity.card.url && (
                    <button
                      className="act-primary act-source-action"
                      disabled={busy}
                      onClick={() => void action(() => props.openSource(selectedEntity.card.url!))}
                    >
                      Open{" "}
                      {reference(currentEntity) === sourceNames[currentEntity.source]
                        ? ""
                        : `${reference(currentEntity)} `}
                      in {sourceNames[selectedEntity.source]} ↗
                    </button>
                  )}
                  {selectedEntity.card.sessions.map((session) => (
                    <button
                      key={`${session.tool}:${session.id}`}
                      className="act-primary act-source-action"
                      disabled={busy}
                      onClick={() => void action(() => props.openSession(session.tool, session.id))}
                    >
                      Open session
                    </button>
                  ))}
                  {!p.hidden?.includes("links") && related.length > 0 && (
                    <>
                      <h3 className="act-eyebrow">Linked work</h3>
                      <div className="act-work-cards">
                        {related.map((entity) => (
                          <div key={entity.id}>{workCard(entity)}</div>
                        ))}
                      </div>
                    </>
                  )}
                  {!p.hidden?.includes("history") && history.length > 0 && (
                    <details className="act-item-history">
                      <summary>Item history · {history.length} events</summary>
                      {history.slice(0, 40).map((event) => (
                        <button
                          key={event.id}
                          className={`act-history-entry ${event.id === selected.id ? "selected" : ""}`}
                          onClick={() => select(event)}
                        >
                          <span className="act-muted">{timestamp(event)}</span>
                          <strong>{title(event, byId.get(event.entityId)!)}</strong>
                          {event.detail && <span>{event.detail}</span>}
                        </button>
                      ))}
                      {history.length > 40 && (
                        <span className="act-muted">
                          Showing the latest 40 events. Open Work Trails for the full history.
                        </span>
                      )}
                    </details>
                  )}
                </>
              ) : (
                <div className="act-empty-inspector">
                  <span className="act-muted">↗</span>
                  <h3>Select an event</h3>
                  <p className="act-muted">
                    See the event, its current state, and linked work, pull requests, discussions and sessions.
                  </p>
                </div>
              )}
            </aside>
          )}
        </div>
        <footer className="act-footer">
          Recording since {day(data.recordingSince)} · Earlier source updates show the last known state.
        </footer>
      </div>
    </OpenUrlContext.Provider>
  );
}
