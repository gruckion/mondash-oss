import { webScrollProps } from "@/lib/web-scroll";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Body, Button } from "@/components/ui";
import { useSettings } from "@/lib/provider";
import { loadDebriefHistory } from "@/lib/api";
import { useTheme } from "@/lib/theme";

export function DebriefHistoryList({
  selectedId,
  onSelect,
  onClose,
}: {
  selectedId?: string;
  onSelect: (id: string) => void;
  onClose?: () => void;
}) {
  const t = useTheme();
  const { server, ready } = useSettings();
  const query = useQuery({
    queryKey: ["debriefHistory", server],
    staleTime: 0,
    queryFn: ({ signal }) => loadDebriefHistory(server, signal),
    enabled: ready && !!server,
  });
  const date = (value: string) =>
    new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  return (
    <ScrollView
      {...webScrollProps}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 16, gap: 12 }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text accessibilityRole="header" style={{ color: t.text, fontWeight: "600", fontSize: 17 }}>
          Saved debriefs
        </Text>
        {onClose && (
          <Pressable accessibilityRole="button" onPress={onClose} style={{ minHeight: 44, justifyContent: "center" }}>
            <Text style={{ color: t.accent, fontSize: 15 }}>Done</Text>
          </Pressable>
        )}
      </View>
      {ready && !server && (
        <>
          <Body muted>Connect your Mac in Settings to read saved debriefs.</Body>
          <Button title="Open Settings" onPress={() => router.replace("/settings")} />
        </>
      )}
      {query.isLoading && <ActivityIndicator color={t.accent} />}
      {query.error && (
        <>
          <Body>{query.error.message}</Body>
          <Button title="Try again" onPress={() => void query.refetch()} />
        </>
      )}
      {query.data?.length === 0 && <Body muted>No saved debriefs yet. Generate one from the Debrief screen.</Body>}
      {query.data?.map((report, index) => (
        <Pressable
          key={report.id}
          accessibilityRole="button"
          onPress={() => onSelect(report.id)}
          accessibilityState={{ selected: selectedId ? selectedId === report.id : index === 0 }}
          style={({ pressed }) => ({
            paddingVertical: 14,
            paddingHorizontal: 12,
            borderRadius: 12,
            backgroundColor: pressed || (selectedId ? selectedId === report.id : index === 0) ? t.tint : t.chip,
            gap: 6,
          })}
        >
          <Text style={{ color: t.text, fontSize: 15, fontWeight: "600" }}>
            {date(report.since)} – {date(report.until)}
            {index === 0 ? " · Latest" : ""}
          </Text>
          <Text style={{ color: t.secondary, fontSize: 13 }}>
            Saved {new Date(report.generatedAt).toLocaleString("en-GB")} · {report.scannedThreads} conversations
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}
