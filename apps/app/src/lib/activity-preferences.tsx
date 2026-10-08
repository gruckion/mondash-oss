import { createContext, use, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Option, Schema } from "effect";
import { ActivityPreferences } from "@mondash/shared/contract";
import { useSettings } from "./provider";

const defaults: ActivityPreferences = {
  view: "stream",
  query: "",
  days: 7,
  sources: [],
  needs: false,
  work: "",
  selected: null,
  handled: {},
  hidden: [],
};
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(ActivityPreferences));
const ActivityContext = createContext({
  preferences: defaults,
  ready: false,
  update: (_patch: Partial<ActivityPreferences>) => {},
});
export const useActivityPreferences = () => use(ActivityContext);

/** The header, options sheet and four views share one server-scoped preference owner. */
export function ActivityPreferencesProvider({ children }: { children: ReactNode }) {
  const { server } = useSettings();
  const key = `mondash:activity:v1:${server}`;
  const [saved, setSaved] = useState<{ key: string; value: ActivityPreferences } | null>(null);
  const queue = useRef(Promise.resolve());
  useEffect(() => {
    let mounted = true;
    void AsyncStorage.getItem(key)
      .then((json) => {
        const decoded = json ? decode(json) : Option.none();
        if (mounted) setSaved({ key, value: { ...defaults, ...Option.getOrUndefined(decoded) } });
      })
      .catch(() => {
        if (mounted) setSaved({ key, value: defaults });
      });
    return () => {
      mounted = false;
    };
  }, [key]);
  const ready = saved?.key === key;
  const preferences = ready ? saved.value : defaults;
  const persist = useEffectEvent((storageKey: string, value: ActivityPreferences) => {
    queue.current = queue.current.catch(() => {}).then(() => AsyncStorage.setItem(storageKey, JSON.stringify(value)));
    void queue.current.catch(() => {});
  });
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => persist(key, preferences), 250);
    return () => clearTimeout(timer);
  }, [key, preferences, ready]);
  const update = (patch: Partial<ActivityPreferences>) => {
    if (!ready) return;
    setSaved((before) => ({ key, value: { ...(before?.key === key ? before.value : defaults), ...patch } }));
  };
  return <ActivityContext value={{ preferences, ready, update }}>{children}</ActivityContext>;
}
