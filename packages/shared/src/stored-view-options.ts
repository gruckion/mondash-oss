import { Schema } from "effect";
import { viewOptionsFor, type ViewOptions, type ViewSection } from "./view-options";

/** Keep the v1 key: retired preferences are discarded while existing choices survive. */
export const StoredViewOptions = Schema.Record(
  Schema.String,
  Schema.Struct({
    sort: Schema.String,
    filters: Schema.Record(Schema.String, Schema.Array(Schema.String)),
    hidden: Schema.Array(Schema.String),
  }),
);

export type StoredViews = typeof StoredViewOptions.Type;
type Update = { type: "update"; section: ViewSection; next: (view: ViewOptions) => ViewOptions };
export type ViewPreferencesState = { views: StoredViews; ready: boolean; pending: readonly Update[] };
function change(views: StoredViews, action: Update): StoredViews {
  return { ...views, [action.section]: action.next(viewOptionsFor(action.section, views[action.section])) };
}

/** Replay changes made while mobile storage was loading, preserving the saved sort/filter/display choices. */
export function viewPreferencesReducer(
  state: ViewPreferencesState,
  action: Update | { type: "loaded"; views: StoredViews },
): ViewPreferencesState {
  if (action.type === "loaded") {
    if (state.ready) return state;
    return { views: state.pending.reduce(change, action.views), ready: true, pending: [] };
  }
  return {
    ...state,
    views: change(state.views, action),
    pending: state.ready ? [] : [...state.pending, action],
  };
}
