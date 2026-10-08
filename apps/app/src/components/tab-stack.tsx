import { TooltipButton as Pressable } from "./tooltip-button";
import { Stack, router, type Href } from "expo-router";
import { Platform, Text, useWindowDimensions, View } from "react-native";
import { useDesktopPanel } from "@/lib/desktop-panel";
import { useTheme } from "@/lib/theme";
import { Icon, type IconName } from "./icon";
import { useInboxUnread } from "./inbox-screen";
import { useProviderHealth } from "@/lib/provider";
import { useProviderWarning } from "@/lib/use-provider-warning";
import { providerProblems } from "@/lib/provider-health";
import { ConnectionIndicators, ConnectionWarningDot } from "./connection-indicators";
import { MoreMenu } from "./more-menu";

import { DESKTOP_WORK_WIDTH } from "./work-screen";
import { MOBILE_WIDTH } from "@/lib/mobile-view";
import { WorkNavigation } from "./work-navigation";

type Tab = "issues" | "scoping" | "reviews" | "sessions" | "activity";

function HeaderButton({
  icon,
  label,
  onPress,
  badge = 0,
  showLabel = false,
  warning,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  badge?: number;
  showLabel?: boolean;
  warning?: string;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      tooltip={
        warning ??
        (label === "Inbox"
          ? `Open or close your inbox${badge ? ` · ${badge} unread` : ""}`
          : label === "Debrief"
            ? "Read your debrief and saved reports"
            : label === "Settings"
              ? "Connections and app settings"
              : label === "Sessions"
                ? "Browse and resume your agent sessions"
                : "Return to your work dashboard")
      }
      accessibilityLabel={warning ? `${label}, ${warning}` : badge ? `${label}, ${badge} unread` : label}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => ({
        flexDirection: "row",
        gap: 6,
        paddingHorizontal: showLabel ? 10 : 0,
        minHeight: 44,
        minWidth: 44,
        justifyContent: "center",
        alignItems: "center",
        opacity: pressed ? 0.5 : 1,
      })}
    >
      <Icon name={icon} color={t.dark ? "#ffffff" : t.text} size={22} />
      {showLabel && <Text style={{ color: t.text, fontSize: 14, fontWeight: "500" }}>{label}</Text>}
      {badge > 0 && (
        <View
          style={{
            position: "absolute",
            top: 4,
            right: 2,
            minWidth: 18,
            height: 18,
            paddingHorizontal: 5,
            borderRadius: 9,
            backgroundColor: "#ff3b30",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text
            style={{
              color: "#ffffff",
              fontSize: 11,
              fontWeight: "700",
              fontVariant: ["tabular-nums"],
            }}
          >
            {badge}
          </Text>
        </View>
      )}
      {!!warning && <ConnectionWarningDot />}
    </Pressable>
  );
}

/** Inbox sits top right on every tab, where a glance finds its badge; it opens inside the tab you are on. */
export function HeaderButtons({ tab }: { tab: Tab }) {
  const unread = useInboxUnread();
  const warning = useProviderWarning();
  const { width } = useWindowDimensions();
  const desktop = Platform.OS === "web" && width >= DESKTOP_WORK_WIDTH;
  const mobile = Platform.OS !== "web" || width < MOBILE_WIDTH;
  const panel = useDesktopPanel();
  const inbox: Href = `/${tab}/inbox`;
  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      {desktop && (
        <HeaderButton
          icon="terminal"
          label="Sessions"
          showLabel
          onPress={() => panel?.setActive(panel.active === "sessions" ? null : "sessions")}
        />
      )}
      <HeaderButton
        icon="tray"
        label="Inbox"
        badge={unread}
        onPress={() =>
          panel?.enabled ? panel.setActive(panel.active === "inbox" ? null : "inbox") : router.push(inbox)
        }
      />
      {mobile ? (
        tab === "activity" ? (
          <HeaderButton icon="gearshape" label="Settings" onPress={() => router.push("/settings")} />
        ) : (
          <MoreMenu section={tab} />
        )
      ) : (
        <>
          <HeaderButton icon="doc.text" label="Debrief" onPress={() => router.push("/debrief")} />
          <HeaderButton icon="gearshape" label="Settings" warning={warning} onPress={() => router.push("/settings")} />
        </>
      )}
    </View>
  );
}

export function TabStack({ title, tab }: { title: string; tab: Tab }) {
  const t = useTheme();
  const health = useProviderHealth();
  const problems = providerProblems(health.data?.connections ?? []);
  const { width } = useWindowDimensions();
  const desktop = Platform.OS === "web" && width >= DESKTOP_WORK_WIDTH && tab !== "sessions";
  return (
    <Stack
      screenOptions={{
        headerLargeTitle: false,
        headerShadowVisible: false,
        headerStyle: { backgroundColor: t.background },
        headerTintColor: t.accent,
        headerTitleStyle: { color: t.text },
        contentStyle: { backgroundColor: t.background },
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          title: tab === "activity" ? "Activity · Beta" : desktop ? "Work" : title,
          headerTitle:
            desktop || tab === "activity"
              ? () => <WorkNavigation active={tab === "activity" ? "activity" : "work"} />
              : undefined,
          headerTitleAlign: "center",
          headerLeft: problems.length ? () => <ConnectionIndicators problems={problems} /> : undefined,
          headerRight: () => <HeaderButtons tab={tab} />,
        }}
      />
      {/* One Inbox per tab: a second tap while it opens reuses it instead of pushing another. */}
      <Stack.Screen
        name="inbox"
        dangerouslySingular
        options={{
          title: "Inbox",
          headerRight: () => <MoreMenu section="inbox" />,
        }}
      />
    </Stack>
  );
}
