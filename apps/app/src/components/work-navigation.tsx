import { useState } from "react";
import { router } from "expo-router";
import { Modal, Pressable, Text, View } from "react-native";
import { ACTIVITY_VIEWS, type ActivityView } from "@mondash/shared/activity";
import { useActivityPreferences } from "@/lib/activity-preferences";
import { useTheme } from "@/lib/theme";
import { Icon } from "./icon";

const names: Record<ActivityView, string> = {
  stream: "Stream",
  trails: "Work Trails",
  lanes: "Timeline",
  attention: "Attention",
};
export function WorkNavigation({ active }: { active: "work" | "activity" }) {
  const t = useTheme();
  const { preferences, ready, update } = useActivityPreferences();
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <View style={{ flexDirection: "row", gap: 3, padding: 3, backgroundColor: t.chip, borderRadius: 12 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Work"
          onPress={() => router.navigate("/issues")}
          style={{
            minHeight: 36,
            paddingHorizontal: 18,
            justifyContent: "center",
            borderRadius: 9,
            backgroundColor: active === "work" ? t.background : "transparent",
          }}
        >
          <Text style={{ color: active === "work" ? t.text : t.secondary, fontSize: 14, fontWeight: "600" }}>Work</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={!ready}
          accessibilityLabel={
            active === "activity" ? `${names[preferences.view]}, choose activity view` : "Activity, choose view"
          }
          accessibilityState={{ expanded }}
          onPress={() => setExpanded(true)}
          style={{
            minHeight: 36,
            paddingHorizontal: 16,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            borderRadius: 9,
            backgroundColor: active === "activity" ? t.background : "transparent",
          }}
        >
          <Text style={{ color: active === "activity" ? t.text : t.secondary, fontSize: 14, fontWeight: "600" }}>
            {active === "activity" ? names[preferences.view] : "Activity"}
          </Text>
          <Icon name="chevron.down" color={t.secondary} size={12} />
        </Pressable>
      </View>
      <Modal transparent visible={expanded} animationType="fade" onRequestClose={() => setExpanded(false)}>
        <View style={{ flex: 1, alignItems: "center", paddingTop: 64 }}>
          <Pressable
            accessibilityLabel="Close activity views"
            onPress={() => setExpanded(false)}
            style={{ position: "absolute", inset: 0 }}
          />
          <View
            accessibilityViewIsModal
            style={{
              width: 240,
              padding: 6,
              backgroundColor: t.dark ? "#1c1c1e" : "#fff",
              borderRadius: 14,
              borderWidth: 1,
              borderColor: t.line,
              boxShadow: "0 8px 32px rgba(0,0,0,0.24)",
            }}
          >
            {ACTIVITY_VIEWS.map((view) => (
              <Pressable
                key={view}
                accessibilityRole="button"
                accessibilityState={{ selected: preferences.view === view && active === "activity" }}
                onPress={() => {
                  update({ view });
                  setExpanded(false);
                  router.navigate({ pathname: "/activity", params: { view } });
                }}
                style={({ pressed }) => ({
                  minHeight: 44,
                  paddingHorizontal: 12,
                  flexDirection: "row",
                  alignItems: "center",
                  borderRadius: 8,
                  backgroundColor: pressed ? t.chip : "transparent",
                })}
              >
                <Text style={{ flex: 1, color: t.text, fontSize: 15 }}>{names[view]}</Text>
                {preferences.view === view && active === "activity" && (
                  <Icon name="checkmark" color={t.accent} size={16} />
                )}
              </Pressable>
            ))}
          </View>
        </View>
      </Modal>
    </>
  );
}
