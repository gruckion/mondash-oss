import { TooltipButton as Pressable } from "./tooltip-button";
import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Platform, Text, View } from "react-native";
import Animated, { FadeIn, FadeOut, Keyframe } from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { startNewSession } from "@/lib/api";
import { useSettings } from "@/lib/provider";
import { useTheme } from "@/lib/theme";
import { Icon } from "./icon";
import { touchWeb } from "./ui";
import { useLaunch } from "./use-launch";

const SIZE = 48;
const GAP = 12;
/** Room a list leaves under its last row, so the button never covers it. */
export const NEW_MENU_CLEARANCE = SIZE + GAP * 2;

const rise = new Keyframe({
  0: { opacity: 0, transform: [{ translateY: 8 }, { scale: 0.94 }] },
  100: { opacity: 1, transform: [{ translateY: 0 }, { scale: 1 }] },
}).duration(140);

type Item = {
  key: string;
  title: string;
  subtitle: string;
  icon: ReactNode;
  launch: ReturnType<typeof useLaunch>;
};

/**
 * A round "+" floating bottom right, above the tab bar, that opens a menu of things to start, like Slack's. Tapping
 * outside, the button again or an item closes it. An item's work outlives the menu, so its hook lives here.
 */
export function NewMenu({ bottomOffset = 0 }: { bottomOffset?: number } = {}) {
  const t = useTheme();
  const { server, refreshSection } = useSettings();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const web = Platform.OS === "web";
  // A phone browser keeps the link for a second tap, so the menu stays open to show it.
  const close = () => {
    if (!touchWeb()) setOpen(false);
  };
  const claude = useLaunch(
    "Could not start a Claude session",
    () => startNewSession(server),
    close,
    () => refreshSection("sessions"),
  );
  const items: Item[] = [
    {
      key: "claude",
      title: "Claude session",
      subtitle: "New remote session in auto mode",
      icon: (
        <Image
          source={require("../../assets/claude-symbol.svg")}
          contentFit="contain"
          style={{ width: 20, height: 20 }}
        />
      ),
      launch: claude,
    },
  ];
  const busy = items.some((item) => item.launch.busy);

  useEffect(() => {
    if (!open || !web) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, web]);

  if (!server) return null;
  // iOS draws the tab bar over the screen, and the tab's safe area includes it; the web lays the bar out below.
  const bottom = (web ? 0 : insets.bottom) + GAP + bottomOffset;
  const surface = t.dark ? "#1c1c1e" : "#ffffff";
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}>
      {open && (
        <Animated.View
          entering={FadeIn.duration(120)}
          exiting={FadeOut.duration(100)}
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            backgroundColor: t.dark ? "rgba(0,0,0,0.5)" : "rgba(0,0,0,0.2)",
          }}
        >
          <Pressable
            accessibilityRole="button"
            tooltip={false}
            accessibilityLabel="Close menu"
            onPress={() => setOpen(false)}
            style={{ flex: 1 }}
          />
        </Animated.View>
      )}
      {open && (
        <Animated.View
          entering={rise}
          exiting={FadeOut.duration(100)}
          style={{
            position: "absolute",
            right: 20,
            bottom: bottom + SIZE + 10,
            width: 300,
            maxWidth: "88%",
            padding: 6,
            gap: 2,
            borderRadius: 20,
            borderCurve: "continuous",
            backgroundColor: surface,
            borderWidth: 1,
            borderColor: t.line,
            boxShadow: "0 8px 24px rgba(0,0,0,0.16)",
            transformOrigin: "bottom right",
          }}
        >
          {items.map((item) => (
            <MenuRow key={item.key} item={item} onClose={() => setOpen(false)} />
          ))}
        </Animated.View>
      )}
      <Pressable
        accessibilityRole="button"
        tooltip={open ? "Close the new-session menu" : "Start a new agent session"}
        accessibilityLabel={open ? "Close menu" : "New"}
        accessibilityState={{ expanded: open, busy }}
        onPress={() => setOpen(!open)}
        style={({ pressed }) => ({
          position: "absolute",
          right: 20,
          bottom,
          width: SIZE,
          height: SIZE,
          borderRadius: SIZE / 2,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: surface,
          borderWidth: 1,
          borderColor: t.line,
          boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
          opacity: pressed ? 0.6 : 1,
        })}
      >
        {busy && !open ? (
          <ActivityIndicator size="small" color={t.text} />
        ) : (
          <Animated.View
            style={{
              transform: [{ rotate: open ? "45deg" : "0deg" }],
              transitionProperty: "transform",
              transitionDuration: 140,
            }}
          >
            <Icon name="plus" color={t.text} size={22} />
          </Animated.View>
        )}
      </Pressable>
    </View>
  );
}

function MenuRow({ item, onClose }: { item: Item; onClose: () => void }) {
  const t = useTheme();
  const { busy, ready, error, launch } = item.launch;
  const subtitle = busy
    ? "Starting on your Mac…"
    : ready
      ? "Ready, tap to open in Claude"
      : error
        ? `Could not start: ${error}`
        : item.subtitle;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.title}
      accessibilityHint={item.subtitle}
      accessibilityState={{ busy, disabled: busy }}
      disabled={busy}
      onPress={() => {
        if (Platform.OS !== "web") void Haptics.selectionAsync();
        launch();
        // A kept link opens on this tap, so the menu has nothing more to show.
        if (ready) onClose();
      }}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        padding: 10,
        borderRadius: 14,
        borderCurve: "continuous",
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: 10,
          borderCurve: "continuous",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: t.chip,
        }}
      >
        {busy ? <ActivityIndicator size="small" color={t.text} /> : item.icon}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text style={{ color: t.text, fontSize: 15, lineHeight: 20, fontWeight: "600" }}>{item.title}</Text>
        <Text
          numberOfLines={error && !busy && !ready ? 3 : 1}
          style={{
            color: error && !busy && !ready ? t.warning : t.secondary,
            fontSize: 13,
            lineHeight: 18,
          }}
        >
          {subtitle}
        </Text>
      </View>
    </Pressable>
  );
}
