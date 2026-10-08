import { Stack, router, useLocalSearchParams } from "expo-router";
import { Platform, Pressable, Text, useWindowDimensions, View } from "react-native";
import { DebriefHistoryList } from "@/components/debrief-history-list";
import { DebriefView } from "@/components/debrief-view";
import { useTheme } from "@/lib/theme";

export default function DebriefScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const t = useTheme();
  const { width } = useWindowDimensions();
  const wide = Platform.OS === "web" && width >= 1024;
  return (
    <>
      <Stack.Screen
        options={{
          title: "Debrief",
          headerShadowVisible: false,
          headerStyle: { backgroundColor: t.background },
          headerTintColor: t.accent,
          headerTitleStyle: { color: t.text },
          headerRight: () =>
            wide ? null : (
              <Pressable
                accessibilityRole="button"
                onPress={() => router.push("/debrief-history")}
                style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 12 }}
              >
                <Text style={{ color: t.accent, fontSize: 15, fontWeight: "500" }}>History</Text>
              </Pressable>
            ),
        }}
      />
      <View style={{ flex: 1, flexDirection: "row", backgroundColor: t.background }}>
        {wide && (
          <View
            accessibilityLabel="Debrief history sidebar"
            style={{ width: 300, borderRightWidth: 1, borderRightColor: t.line }}
          >
            <DebriefHistoryList selectedId={id} onSelect={(id) => router.setParams({ id })} />
          </View>
        )}
        <View style={{ flex: 1, minWidth: 0 }}>
          <DebriefView key={id ?? "latest"} id={id} />
        </View>
      </View>
    </>
  );
}
