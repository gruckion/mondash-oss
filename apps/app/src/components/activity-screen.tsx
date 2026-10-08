import { lazy, Suspense, useEffect, useEffectEvent } from "react";
import { ActivityIndicator, View, useWindowDimensions } from "react-native";
import { router, useIsFocused, useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { useActivityPreferences } from "@/lib/activity-preferences";
import { activityView } from "@mondash/shared/activity";
import { useSettings } from "@/lib/provider";
import { loadActivity } from "@/lib/api";
import { useTheme } from "@/lib/theme";
import { openUrl, Body, Button } from "./ui";

const ActivityContent = lazy(() => import("./activity-content"));
export function ActivityScreen() {
  const { server, ready } = useSettings();
  const { width } = useWindowDimensions();
  const focused = useIsFocused();
  const t = useTheme();
  const params = useLocalSearchParams<{ work?: string; view?: string }>();
  const query = useQuery({
    queryKey: ["activity", server],
    queryFn: ({ signal }) => loadActivity(server, signal),
    enabled: ready && !!server && focused,
    refetchInterval: focused ? 30000 : false,
    refetchIntervalInBackground: false,
  });
  const { preferences, ready: preferencesReady, update } = useActivityPreferences();
  const applyRoute = useEffectEvent(() => {
    if (!preferencesReady) return;
    if (params.view || params.work)
      update({
        ...(params.view ? { view: activityView(params.view) } : {}),
        ...(params.work ? { work: params.work, selected: null } : {}),
      });
  });
  useEffect(() => {
    applyRoute();
  }, [params.view, params.work, preferencesReady]);
  if (ready && !server)
    return (
      <View style={{ padding: 24, gap: 16 }}>
        <Body>Connect your Mac to read activity.</Body>
        <Button title="Open Settings" onPress={() => router.push("/settings")} />
      </View>
    );
  if (!query.data && query.error)
    return (
      <View style={{ padding: 24, gap: 16 }}>
        <Body>{query.error.message}</Body>
        <Button title="Try again" onPress={() => void query.refetch()} />
      </View>
    );
  if (!query.data || !preferencesReady) return <ActivityIndicator style={{ flex: 1 }} color={t.accent} />;
  return (
    <View style={{ flex: 1, backgroundColor: t.background }}>
      <Suspense fallback={<ActivityIndicator style={{ flex: 1 }} color={t.accent} />}>
        <ActivityContent
          key={server}
          data={query.data}
          preferences={preferences}
          dark={t.dark}
          width={width}
          active={focused}
          changePreferences={async (patch) => {
            update(patch);
            if (patch.view !== undefined || patch.work !== undefined)
              router.setParams({
                ...(patch.view !== undefined ? { view: patch.view } : {}),
                ...(patch.work !== undefined ? { work: patch.work } : {}),
              });
          }}
          openOptions={async (panel) => {
            router.push({ pathname: "/activity-options", params: { panel } });
          }}
          openSource={async (url) => {
            await openUrl(url);
          }}
          openSession={async (tool, id) => {
            router.push({ pathname: "/session/[tool]/[id]", params: { tool, id } });
          }}
          dom={{ scrollEnabled: false, style: { flex: 1 }, contentInsetAdjustmentBehavior: "never" }}
        />
      </Suspense>
    </View>
  );
}
