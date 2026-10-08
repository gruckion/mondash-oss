import { TooltipButton as Pressable } from "./tooltip-button";
import { useEffect } from "react";
import { router, type Href } from "expo-router";
import { Text, useWindowDimensions, View } from "react-native";
import { useDesktopPanel } from "@/lib/desktop-panel";
import { useTheme } from "@/lib/theme";
import { InboxScreen } from "./inbox-screen";
import { SessionsScreen } from "./sessions-screen";
import { Icon } from "./icon";
import { MoreMenu } from "./more-menu";

export function DesktopPanel({ tab }: { tab: string }) {
  const panel = useDesktopPanel();
  const t = useTheme();
  const { width } = useWindowDimensions();
  const active = panel?.active;
  const enabled = panel?.enabled;
  const setActive = panel?.setActive;
  useEffect(() => {
    if (!active || enabled || !setActive) return;
    setActive(null);
    router.push(active === "sessions" ? "/sessions" : (`/${tab}/inbox` as Href));
  }, [active, enabled, setActive, tab]);
  if (!enabled) return null;
  const title = active === "sessions" ? "Sessions" : "Inbox";
  return (
    <View
      accessibilityLabel={`${title} panel`}
      style={{
        display: active ? "flex" : "none",
        width: Math.min(480, Math.max(360, width * 0.28)),
        borderLeftWidth: active === "sessions" ? 0 : 1,
        borderLeftColor: t.line,
        borderRightWidth: active === "sessions" ? 1 : 0,
        borderRightColor: t.line,
        backgroundColor: t.background,
      }}
    >
      <View style={{ height: 64, flexDirection: "row", alignItems: "center", paddingHorizontal: 16, gap: 12 }}>
        <Text accessibilityRole="header" style={{ color: t.text, fontSize: 17, fontWeight: "600", flex: 1 }}>
          {title}
        </Text>
        {active === "inbox" && <MoreMenu section="inbox" />}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Close ${title}`}
          onPress={() => setActive?.(null)}
          style={{ height: 44, width: 44, justifyContent: "center", alignItems: "center" }}
        >
          <Icon name="xmark" size={20} color={t.secondary} />
        </Pressable>
      </View>
      {/* Keep both views mounted so switching blades preserves filters and scroll positions. */}
      <View style={{ flex: 1, minHeight: 0, display: active === "inbox" ? "flex" : "none" }}>
        <InboxScreen />
      </View>
      <View style={{ flex: 1, minHeight: 0, display: active === "sessions" ? "flex" : "none" }}>
        <SessionsScreen />
      </View>
    </View>
  );
}
