import { createContext, use, useCallback, useEffect, useMemo, useReducer, type ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Exit, Schema } from "effect";
import { viewOptionsFor, type DisplayKey, type ViewOptions, type ViewSection } from "@mondash/shared/view-options";
import { StoredViewOptions, viewPreferencesReducer, type StoredViews } from "@mondash/shared/stored-view-options";

const KEY = "mondash:view-options:v1";
type Views = StoredViews;
const decodeStored = Schema.decodeUnknownExit(StoredViewOptions);

const Context = createContext<{
  views: Views;
  update: (section: ViewSection, next: (view: ViewOptions) => ViewOptions) => void;
} | null>(null);

/** Each screen's sort, filters and hidden card parts, kept on this device. */
export function ViewOptionsProvider({ children }: { children: ReactNode }) {
  const [{ views, ready }, dispatch] = useReducer(viewPreferencesReducer, { views: {}, ready: false, pending: [] });
  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(KEY)
      .then((text) => {
        const parsed = text ? decodeStored(JSON.parse(text)) : undefined;
        if (!cancelled) dispatch({ type: "loaded", views: parsed && Exit.isSuccess(parsed) ? parsed.value : {} });
      })
      .catch((error) => {
        console.warn(error);
        if (!cancelled) dispatch({ type: "loaded", views: {} });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (ready) AsyncStorage.setItem(KEY, JSON.stringify(views)).catch(console.warn);
  }, [views, ready]);
  const update = useCallback(
    (section: ViewSection, next: (view: ViewOptions) => ViewOptions) => dispatch({ type: "update", section, next }),
    [],
  );
  const value = useMemo(() => ({ views, update }), [views, update]);
  return <Context value={value}>{children}</Context>;
}

export function useViewOptions(section: ViewSection) {
  const state = use(Context);
  if (!state) throw new Error("View options provider missing");
  const saved = state.views[section];
  const view = useMemo(() => viewOptionsFor(section, saved), [section, saved]);
  return {
    view,
    update: (next: (view: ViewOptions) => ViewOptions) => state.update(section, next),
  };
}

/** The card parts the screen shows. Outside a screen (a sheet), everything shows. */
const Display = createContext<ReadonlySet<string>>(new Set());
export const DisplayProvider = Display.Provider;
export function useShows() {
  const hidden = use(Display);
  return (key: DisplayKey) => !hidden.has(key);
}
