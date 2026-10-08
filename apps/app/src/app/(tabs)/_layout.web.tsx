import { DesktopPanel } from "@/components/desktop-panel";
import { DesktopPanelProvider, useDesktopPanel } from "@/lib/desktop-panel";
import { Navigator } from "expo-router";
import { DESKTOP_WORK_WIDTH } from "@/components/work-screen";
import { Pressable, Text, useWindowDimensions, View } from "react-native";
// Not "expo-router/ui": that file is `export *` over CommonJS, which tree shaking empties, so Tabs came out undefined.
import { TabList, TabSlot, TabTrigger, Tabs, type TabTriggerSlotProps } from "expo-router/build/ui";
import { Icon, type IconName } from "@/components/icon";
import { SegmentTrack, WEB_TOP_TABS_WIDTH } from "@/components/segment-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSegments } from "@/lib/segments";
import { useTheme } from "@/lib/theme";
import { useBottomViewSection } from "@/lib/mobile-view";
import { SessionSearchInput } from "@/components/session-search-input";

/** Phones use bottom tabs; intermediate widths keep a sidebar; desktop uses header navigation. */
const WIDE = WEB_TOP_TABS_WIDTH;

const TABS: { name: string; title: string; icon: IconName }[] = [
  { name: "issues", title: "Issues", icon: "dot.viewfinder" },
  { name: "scoping", title: "Scoping", icon: "square.stack.3d.up" },
  { name: "reviews", title: "Reviews", icon: "review.branch" },
  { name: "activity", title: "Activity", icon: "clock" },
  { name: "sessions", title: "Sessions", icon: "terminal" },
];

function TabButton({
  icon,
  title,
  wide,
  isFocused,
  active,
  ...props
}: TabTriggerSlotProps & { icon: IconName; title: string; wide: boolean; active?: boolean }) {
  const t = useTheme();
  const selected = active ?? isFocused;
  const color = selected ? t.accent : t.secondary;
  return (
    <Pressable
      {...props}
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      style={
        wide
          ? {
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              paddingHorizontal: 12,
              paddingVertical: 9,
              borderRadius: 10,
              backgroundColor: selected ? t.chip : "transparent",
            }
          : {
              flex: 1,
              alignItems: "center",
              justifyContent: "center",
              gap: 3,
              paddingTop: 7,
              paddingBottom: 5,
            }
      }
    >
      <Icon name={icon} color={color} size={wide ? 18 : 22} />
      <Text
        style={{
          color: wide ? t.text : color,
          fontSize: wide ? 14 : 10,
          fontWeight: selected ? "600" : "500",
        }}
      >
        {title}
      </Text>
    </Pressable>
  );
}

/** The focused screen's tabs, floating above the bottom edge as the iOS accessory does. */
function FloatingSegments() {
  const t = useTheme();
  const { segments } = useSegments();
  const section = useBottomViewSection();
  const { width } = useWindowDimensions();
  if (width >= WEB_TOP_TABS_WIDTH || !section || section === "reviews") return null;
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 12,
        alignItems: "center",
        paddingHorizontal: 12,
      }}
    >
      <View
        style={{
          width: section === "sessions" || segments ? "100%" : undefined,
          maxWidth: 520,
          height: section === "sessions" ? 48 : 44,
          flexDirection: "row",
          alignItems: section === "sessions" ? "center" : "stretch",
          borderRadius: 999,
          backgroundColor: t.dark ? "#1c1c1e" : "#ffffff",
          borderWidth: 1,
          borderColor: t.line,
          boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
        }}
      >
        {section === "sessions" ? <SessionSearchInput /> : segments && <SegmentTrack />}
      </View>
    </View>
  );
}

/** Read only this tab navigator: a root modal must not change the background's width or selection. */
function TabsContent() {
  const t = useTheme();
  const panel = useDesktopPanel();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE;
  const desktop = width >= DESKTOP_WORK_WIDTH;
  const { state } = Navigator.useContext();
  const tab = state.routes[state.index];
  const workTab = tab.name === "issues" || tab.name === "scoping" || tab.name === "reviews";
  const insets = useSafeAreaInsets();
  return (
    // Keep the same navigator subtree when resizing. Only flex direction and navigation styling change.
    <View style={{ flex: 1, minWidth: 0, flexDirection: wide ? "row" : "column-reverse" }}>
      <View
        accessibilityRole="tablist"
        style={
          desktop
            ? { display: "none" }
            : wide
              ? {
                  width: 208,
                  paddingTop: 20,
                  paddingHorizontal: 12,
                  gap: 2,
                  borderRightWidth: 1,
                  borderRightColor: t.line,
                }
              : {
                  flexDirection: "row",
                  borderTopWidth: 1,
                  borderTopColor: t.line,
                  backgroundColor: t.background,
                  paddingBottom: insets.bottom,
                }
        }
      >
        {wide && (
          <Text style={{ color: t.text, fontSize: 17, fontWeight: "700", paddingHorizontal: 12, paddingBottom: 14 }}>
            Mondash
          </Text>
        )}
        {TABS.filter(
          (item) => !desktop || item.name === "issues" || item.name === "activity" || item.name === "sessions",
        ).map((item) => (
          <TabTrigger key={item.name} name={item.name} asChild>
            <TabButton
              icon={item.icon}
              title={desktop && item.name === "issues" ? "Work" : item.title}
              wide={wide}
              active={desktop && item.name === "issues" ? workTab : undefined}
            />
          </TabTrigger>
        ))}
      </View>
      <View
        style={{
          flex: 1,
          minWidth: 0,
          flexDirection: panel?.enabled && panel.active === "sessions" ? "row-reverse" : "row",
        }}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <TabSlot />
          <FloatingSegments />
        </View>
        <DesktopPanel tab={tab.name} />
      </View>
    </View>
  );
}

/** Keep one navigator across desktop header navigation, tablet sidebar, and phone bottom tabs. */
export default function TabsLayout() {
  const t = useTheme();
  const { width } = useWindowDimensions();
  return (
    <DesktopPanelProvider enabled={width >= DESKTOP_WORK_WIDTH}>
      <Tabs style={{ flex: 1, backgroundColor: t.background }}>
        <TabList style={{ display: "none" }}>
          {TABS.map((tab) => (
            <TabTrigger key={tab.name} name={tab.name} href={`/${tab.name}`} />
          ))}
        </TabList>
        <TabsContent />
      </Tabs>
    </DesktopPanelProvider>
  );
}
