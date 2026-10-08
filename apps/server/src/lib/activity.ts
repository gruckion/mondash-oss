import { createHash } from "node:crypto";
import { DateTime, Effect, Schema, Semaphore } from "effect";
import { ActivityEntity, ActivityEvent, SectionResponse } from "@mondash/shared/contract";
import { activityEntities, activityIdentity, activityWorkLinks } from "@mondash/shared/activity";
import { Store, storeKey } from "@/services/store";

const Journal = Schema.Struct({
  recordingSince: Schema.String,
  sections: Schema.Array(SectionResponse),
  events: Schema.Array(ActivityEvent),
  entities: Schema.Array(ActivityEntity),
});
const LEGACY_KEY = storeKey("activity:journal:v1", Journal);
const PREVIOUS_KEY = storeKey("activity:journal:v2", Journal);
const KEY = storeKey("activity:journal:v3", Journal);
const lock = Semaphore.makeUnsafe(1);
// v3 rebuilds work links, repairs hydrated timestamps and replaces session output
// history with one latest snapshot. The store retains one predecessor for recovery.
// v1 observed transitions confused notification actions with work state and are discarded.
const readJournal = Effect.fn("activity.readJournal")(function* () {
  const store = yield* Store;
  const current = (yield* store.read(KEY))?.value;
  if (current) return current;
  const previous = (yield* store.read(PREVIOUS_KEY))?.value;
  const legacy = previous ?? (yield* store.read(LEGACY_KEY))?.value;
  if (!legacy) return undefined;
  const entities = activityEntities(legacy.sections);
  const ids = new Set(entities.map((entity) => entity.id));
  const identities = new Map(legacy.entities.map((entity) => [entity.id, activityIdentity(entity.card)]));
  const allEntities = activityWorkLinks([
    ...entities,
    ...legacy.entities
      .filter((entity) => !ids.has(activityIdentity(entity.card)))
      .map((entity) => ({
        ...entity,
        id: activityIdentity(entity.card),
        workIds: entity.workIds.map((id) => identities.get(id) ?? id),
        inCurrentWork: false,
      })),
  ]);
  const byId = new Map(allEntities.map((entity) => [entity.id, entity]));
  const events = new Map(
    legacy.events
      .filter((event) => previous || event.timeBasis !== "observed")
      .map((event) => {
        const entityId = identities.get(event.entityId) ?? event.entityId;
        const entity = byId.get(entityId);
        const occurredAt =
          event.action === "Last updated" && !event.occurredAt ? (entity?.card.updatedAt ?? null) : event.occurredAt;
        const updated =
          occurredAt !== event.occurredAt
            ? {
                ...event,
                id: digest([entityId, event.action, occurredAt, event.detail]),
                entityId,
                occurredAt,
                timeBasis: "source" as const,
              }
            : { ...event, entityId };
        return [updated.id, updated];
      }),
  );
  const snapshots = new Map<string, ActivityEvent>();
  for (const event of events.values()) {
    if (!["Last updated", "Session activity"].includes(event.action)) continue;
    const key = `${event.entityId}:${event.action}`;
    const previous = snapshots.get(key);
    if (!previous || (event.occurredAt ?? "") > (previous.occurredAt ?? "")) {
      if (previous) events.delete(previous.id);
      snapshots.set(key, event);
    } else events.delete(event.id);
  }
  const now = DateTime.formatIso(yield* DateTime.now);
  for (const entity of allEntities) {
    if (entity.card.kind === "session") {
      const history = [...events.values()].filter((event) => event.entityId === entity.id);
      if (history.length) {
        const latest = history.sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
        const occurredAt =
          entity.card.updatedAt ??
          entity.card.sessions[0]?.updatedAt ??
          (latest.timeBasis === "source" ? latest.occurredAt : null);
        const detail = entity.card.sessions[0]?.preview;
        const id = digest([entity.id, "Session activity", occurredAt, detail]);
        for (const event of history) events.delete(event.id);
        events.set(id, {
          id,
          entityId: entity.id,
          action: "Session activity",
          occurredAt,
          observedAt: latest.observedAt,
          timeBasis: occurredAt ? "source" : "unknown",
          ...(detail ? { detail } : {}),
        });
      }
      continue;
    }
    if (previous || !entity.id.startsWith("notification:") || !entity.card.feedSource) continue;
    const action = entity.card.status || "Discussion activity";
    const occurredAt = entity.card.updatedAt ?? null;
    const id = digest([entity.id, action, occurredAt, undefined]);
    events.set(id, {
      id,
      entityId: entity.id,
      action,
      occurredAt,
      observedAt: now,
      timeBasis: occurredAt ? "source" : "unknown",
    });
  }
  const migrated = {
    ...legacy,
    entities: allEntities,
    events: [...events.values()],
  };
  yield* store.write(KEY, migrated);
  return migrated;
});
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
const state = (entity: ActivityEntity) => ({
  title: entity.card.title,
  subtitle: entity.card.subtitle,
  sessionPreview: entity.card.kind === "session" ? entity.card.sessions[0]?.preview : undefined,
  status: entity.card.status,
  prState: entity.card.prState,
  checks: entity.card.checks,
  review: entity.card.reviewDecision,
  checksSummary: entity.card.checksSummary,
  unread: entity.card.unread,
  done: entity.card.done,
  attention: entity.card.attention,
  running: entity.card.kind === "session" ? entity.card.sessions[0]?.running : undefined,
  calendarEvent: entity.card.calendarEvent,
  changes: entity.card.changes,
  badges: (entity.card.badges ?? []).map((badge) => badge.text).sort(),
});

/** Called on normalized section refreshes, including the background warm loop. One serialized write per sample. */
export const recordActivitySection = Effect.fn("activity.recordSection")(function* (section: SectionResponse) {
  const store = yield* Store;
  const now = DateTime.formatIso(yield* DateTime.now);
  const before = yield* readJournal();
  const previousSection = before?.sections.find((saved) => saved.section === section.section);
  // A late request must not move current state backwards.
  if (previousSection && previousSection.generatedAt > section.generatedAt) return;
  const sections = [...(before?.sections ?? []).filter((saved) => saved.section !== section.section), section];
  const previous = new Map((before?.entities ?? []).map((entity) => [entity.id, entity]));
  const entities = activityEntities(sections);
  const events = new Map((before?.events ?? []).map((event) => [event.id, event]));
  for (const entity of entities) {
    const old = previous.get(entity.id);
    const notification = entity.id.startsWith("notification:");
    const changes = old && digest(state(old)) !== digest(state(entity));
    const at = entity.card.updatedAt ?? null;
    const append = (
      action: string,
      occurredAt: string | null,
      timeBasis: ActivityEvent["timeBasis"],
      detail?: string,
    ) => {
      const id = digest([entity.id, action, occurredAt, detail]);
      if (!events.has(id))
        events.set(id, {
          id,
          entityId: entity.id,
          action,
          occurredAt,
          observedAt: now,
          timeBasis,
          ...(detail ? { detail } : {}),
        });
    };
    if (entity.card.kind === "session") {
      // A session is a moving latest snapshot, not an event for every agent output.
      const detail = entity.card.sessions[0]?.preview;
      const id = digest([entity.id, "Session activity", at, detail]);
      for (const event of events.values()) if (event.entityId === entity.id && event.id !== id) events.delete(event.id);
      append("Session activity", at, at ? "source" : "unknown", detail);
      continue;
    }
    if (at)
      for (const event of events.values()) {
        if (event.entityId !== entity.id || event.action !== "Last updated" || event.occurredAt) continue;
        events.delete(event.id);
        append("Last updated", at, "source", event.detail);
      }
    if (changes && old && !notification) {
      const detail =
        old.card.status !== entity.card.status
          ? `${old.card.status || "Unknown"} → ${entity.card.status || "Unknown"}`
          : old.card.prState !== entity.card.prState
            ? `${old.card.prState ?? "Unknown"} → ${entity.card.prState ?? "Unknown"}`
            : old.card.checks !== entity.card.checks
              ? `Checks: ${old.card.checks ?? "Unknown"} → ${entity.card.checks ?? "Unknown"}`
              : old.card.reviewDecision !== entity.card.reviewDecision
                ? `Review: ${old.card.reviewDecision ?? "Unknown"} → ${entity.card.reviewDecision ?? "Unknown"}`
                : entity.card.subtitle || "Work details changed";
      append("Change observed", now, "observed", detail);
    } else if (!old || at !== old.card.updatedAt) {
      if (old && !notification) {
        // A timestamp-only refresh is a newer snapshot, not another known action.
        for (const event of events.values())
          if (event.entityId === entity.id && event.timeBasis !== "observed" && event.action === "Last updated")
            events.delete(event.id);
      }
      append(
        notification && entity.card.feedSource ? entity.card.status || "Discussion activity" : "Last updated",
        at,
        at ? "source" : "unknown",
      );
    }
    if (entity.card.assigned?.at)
      append(
        "Assigned",
        entity.card.assigned.at,
        "source",
        entity.card.assigned.people.map((person) => person.name).join(", "),
      );
    const created = entity.card.rows?.find((row) => row.url === entity.card.url)?.createdAt;
    if (created) append("Created", created, "source");
    if (entity.card.calendarEvent)
      append(
        "Meeting",
        entity.card.calendarEvent.startsAt,
        "source",
        entity.card.calendarEvent.endsAt ? `Ends ${entity.card.calendarEvent.endsAt}` : undefined,
      );
  }
  // Event IDs survive refreshes/restarts. Keep a bounded 90-day window and the current undated context.
  const currentIds = new Set(entities.map((entity) => entity.id));
  const allEntities = activityWorkLinks([
    ...entities,
    ...[...previous.values()]
      .filter((entity) => !currentIds.has(entity.id))
      .map((entity) => ({ ...entity, inCurrentWork: false })),
  ]);
  const entityIds = new Set(allEntities.map((entity) => entity.id));
  const cutoff = Date.parse(now) - 90 * 86400000;
  const retained = [...events.values()]
    .filter((event) => entityIds.has(event.entityId) && (!event.occurredAt || Date.parse(event.occurredAt) >= cutoff))
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
    .slice(0, 3000);
  const keepIds = new Set(retained.map((event) => event.entityId));
  for (const entity of allEntities) if (keepIds.has(entity.id)) for (const id of entity.workIds) keepIds.add(id);
  yield* store.write(KEY, {
    recordingSince: before?.recordingSince ?? now,
    sections,
    events: retained,
    entities: allEntities.filter((entity) => entity.inCurrentWork || keepIds.has(entity.id)),
  });
}, lock.withPermits(1));

/** Reads only stored normalized work; never makes provider calls or exposes raw provider payloads. */
export const readActivity = Effect.fn("activity.read")(function* () {
  const store = yield* Store;
  const now = DateTime.formatIso(yield* DateTime.now);
  const journal = yield* readJournal();
  return {
    version: 1 as const,
    generatedAt: now,
    recordingSince: journal?.recordingSince ?? now,
    entities: journal?.entities ?? [],
    events: journal?.events ?? [],
    sections: (journal?.sections ?? []).map(({ section, updatedAt, stale }) => ({ section, updatedAt, stale })),
    unavailable: [],
  };
}, lock.withPermits(1));
