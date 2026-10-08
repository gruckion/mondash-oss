import assert from "node:assert/strict";
import test from "node:test";
import { Schema } from "effect";
import { StoredViewOptions, viewPreferencesReducer } from "./stored-view-options";
import { DEFAULT_VIEW, viewOptionsFor } from "./view-options";

const decode = Schema.decodeUnknownSync(StoredViewOptions);
test("existing device preferences remain valid and discard the retired stacking option", () => {
  const old = { issues: { sort: "priority", filters: { label: ["Prio"] }, hidden: ["slack"] } };
  assert.deepEqual(decode(old), old);
  for (const stackSharedPRs of [true, false]) {
    assert.deepEqual(decode({ issues: { ...old.issues, stackSharedPRs } }), old);
  }
});

test("a sort change before AsyncStorage finishes loading keeps the selected state and older preferences", () => {
  const early = viewPreferencesReducer(
    { views: {}, ready: false, pending: [] },
    {
      type: "update",
      section: "issues",
      next: (current) => ({ ...current, sort: "title" }),
    },
  );
  const old = {
    issues: { sort: "priority", filters: { label: ["Prio"] }, hidden: ["slack"] },
    reviews: { ...DEFAULT_VIEW, sort: "recent" },
  };
  const loaded = viewPreferencesReducer(early, { type: "loaded", views: old });
  assert.equal(loaded.ready, true);
  assert.deepEqual(loaded.pending, []);
  assert.deepEqual(loaded.views, { ...old, issues: { ...old.issues, sort: "title" } });
  const reset = viewPreferencesReducer(loaded, {
    type: "update",
    section: "issues",
    next: (current) => ({ ...current, sort: "default" }),
  });
  assert.equal(reset.views.issues.sort, "default");
  assert.deepEqual(reset.views.reviews, old.reviews);
  assert.equal(viewPreferencesReducer(reset, { type: "loaded", views: old }), reset);
});
test("view preferences survive the JSON storage round trip", () => {
  const saved = { issues: { ...DEFAULT_VIEW, sort: "title" }, reviews: { ...DEFAULT_VIEW, sort: "recent" } };
  assert.deepEqual(decode(JSON.parse(JSON.stringify(saved))), saved);
});

test("Sessions acquires the archive default without losing saved choices, and an explicit All survives reload", () => {
  const old = { ...DEFAULT_VIEW, sort: "title", filters: { tool: ["Codex"] }, hidden: ["preview"] };
  assert.deepEqual(viewOptionsFor("sessions", old), {
    ...old,
    filters: { tool: ["Codex"], archive: ["Not archived"] },
  });
  const loaded = viewPreferencesReducer(
    { views: {}, ready: false, pending: [] },
    { type: "loaded", views: { sessions: old } },
  );
  const all = viewPreferencesReducer(loaded, {
    type: "update",
    section: "sessions",
    next: (current) => ({ ...current, filters: { ...current.filters, archive: [] } }),
  });
  assert.deepEqual(
    viewOptionsFor("sessions", decode(JSON.parse(JSON.stringify(all.views))).sessions).filters.archive,
    [],
  );
  assert.deepEqual(viewOptionsFor("sessions").filters.archive, ["Not archived"]);
});
