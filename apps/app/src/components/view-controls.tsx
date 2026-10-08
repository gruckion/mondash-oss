import { TooltipButton as Pressable } from "./tooltip-button";
import { ToolbarTabs } from "./segment-bar";
import type { Segments } from "@/lib/segments";
import { createContext, use } from "react";
import { Platform, Text, useWindowDimensions, View } from "react-native";
import { router } from "expo-router";
import { isFiltered, VIEW_CONFIG, type ViewSection } from "@mondash/shared/view-options";
import { useViewOptions } from "@/lib/view-options";
import { useTheme } from "@/lib/theme";
import { Icon, type IconName } from "./icon";
import { MOBILE_WIDTH } from "@/lib/mobile-view";

/** The screen whose options the controls change: set once by the screen, read by every section header in it. */
export const ViewSectionContext = createContext<ViewSection | null>(null);

function ControlButton({
  icon,
  label,
  active,
  onPress,
}: {
  icon: IconName;
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      tooltip={`${label === "Display" ? "Choose which details appear on every card in this section" : "Sort and filter all items in this section"}${active ? " · Custom options active" : ""}`}
      accessibilityLabel={active ? `${label}, on` : label}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        width: 32,
        height: 32,
        borderRadius: 8,
        alignItems: "center",
        justifyContent: "center",
        // A grey tile, as in Notion, says this screen is not showing everything.
        backgroundColor: active || pressed ? t.chip : "transparent",
      })}
    >
      <Icon name={icon} color={active ? t.text : t.secondary} size={18} />
    </Pressable>
  );
}

/** Sort and filter, then Display: what the screen shows and how much of each card. */
export function ViewControls() {
  const section = use(ViewSectionContext);
  if (!section) return null;
  return <Controls section={section} />;
}

function Controls({ section }: { section: ViewSection }) {
  const { width } = useWindowDimensions();
  const { view } = useViewOptions(section);
  if (Platform.OS !== "web" || width < MOBILE_WIDTH) return null;
  const open = (panel: "filter" | "display") => router.push({ pathname: "/view-options", params: { section, panel } });
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
      <ControlButton
        icon="line.3.horizontal.decrease"
        label="Sort and filter"
        active={view.sort !== "default" || isFiltered(view)}
        onPress={() => open("filter")}
      />
      <ControlButton icon="switch.2" label="Display" active={view.hidden.length > 0} onPress={() => open("display")} />
    </View>
  );
}

/** For a page with no section header: the controls on the right, and what is switched on, in words, on the left. */
export function ViewControlsRow({ tabs }: { tabs?: Segments } = {}) {
  const section = use(ViewSectionContext);
  return section ? <Row section={section} tabs={tabs} /> : null;
}

function Row({ section, tabs }: { section: ViewSection; tabs?: Segments }) {
  const t = useTheme();
  const { view } = useViewOptions(section);
  const config = VIEW_CONFIG[section];
  const filters = Object.values(view.filters).filter((v) => v.length).length;
  const summary = [
    view.sort !== "default" && config.sorts.find((s) => s.key === view.sort)?.title,
    filters > 0 && `${filters} filter${filters > 1 ? "s" : ""}`,
    view.hidden.length > 0 && `${view.hidden.length} hidden`,
  ].filter(Boolean);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        minHeight: 40,
        gap: 8,
      }}
    >
      <Text numberOfLines={1} style={{ flex: 1, color: t.secondary, fontSize: 12 }}>
        {summary.join(" · ")}
      </Text>
      {tabs && <ToolbarTabs tabs={tabs} />}
      <Controls section={section} />
    </View>
  );
}
