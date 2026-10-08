import { Tooltip } from "./tooltip";
import { useEffect, useRef, useState } from "react";
import * as Haptics from "expo-haptics";
import { Platform, Pressable, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { useSegments, type Segments } from "@/lib/segments";
import { useTheme } from "@/lib/theme";

/**
 * The focused screen's tabs, in the tab bar's bottom accessory (iOS 26), right above the tab bar where a thumb
 * reaches them. The accessory draws the glass; this draws the labels and the sliding highlight. Tap a tab, or drag
 * across the bar: the highlight follows the finger and each tab it enters opens with a haptic tick.
 */
export function SegmentBar() {
  // react-native-screens mounts both placements; only the regular one draws (as the Ecosave app does).
  const placement = NativeTabs.BottomAccessory.usePlacement();
  return placement === "regular" ? <SegmentTrack /> : null;
}

export const WEB_TOP_TABS_WIDTH = 768;

function TabLabel({
  title,
  count,
  selected,
  compact = false,
  small = false,
}: {
  title: string;
  count?: number;
  selected: boolean;
  compact?: boolean;
  small?: boolean;
}) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: compact ? 4 : 6, flexShrink: 1 }}>
      <Text
        numberOfLines={1}
        style={{
          color: compact && !selected ? t.secondary : t.text,
          fontSize: compact ? 12 : small ? 13 : 14,
          fontWeight: selected ? "700" : "500",
          flexShrink: 1,
        }}
      >
        {title}
      </Text>
      {!!count && count > 0 && (
        <View
          style={{
            minWidth: compact ? 16 : 18,
            height: compact ? 16 : 18,
            paddingHorizontal: 4,
            borderRadius: 999,
            backgroundColor: "#ff3b30",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text
            style={{ color: "#ffffff", fontSize: compact ? 10 : 11, fontWeight: "700", fontVariant: ["tabular-nums"] }}
          >
            {count > 99 ? "99+" : count}
          </Text>
        </View>
      )}
    </View>
  );
}

const tabLabel = (title: string, count?: number) => (count && count > 0 ? `${title}, ${count}` : title);

/** The labels and sliding highlight; the web draws its own container around it. */
export function SegmentTrack({ tabs }: { tabs?: Segments } = {}) {
  const t = useTheme();
  const { segments: accessory } = useSegments();
  const segments = tabs ?? accessory;
  const [track, setTrack] = useState(0);
  const count = segments?.titles.length ?? 0;
  const segment = count ? (track - 8) / count : 0;
  const selected = segments?.selected ?? 0;
  const key = segments?.key;
  const x = useSharedValue(0);
  const origin = useSharedValue(0);
  const index = useSharedValue(0);
  const dragging = useSharedValue(false);
  const shown = useRef(key);

  // A new screen jumps straight to its tab; a tap on the same screen slides there. Mid-drag the finger owns it.
  useEffect(() => {
    index.set(selected);
    if (dragging.get()) return;
    if (key !== shown.current) {
      shown.current = key;
      x.set(selected * segment);
      return;
    }
    x.set(withTiming(selected * segment, { duration: 180 }));
  }, [key, selected, segment, x, index, dragging]);

  const enter = (i: number) => {
    if (Platform.OS !== "web") void Haptics.selectionAsync();
    segments?.onSelect(i);
  };
  const max = segment * Math.max(0, count - 1);
  const pan = Gesture.Pan()
    // Only a sideways drag; taps stay with the tabs.
    .activeOffsetX([-8, 8])
    .failOffsetY([-14, 14])
    .onStart(() => {
      dragging.set(true);
      origin.set(x.get());
    })
    .onUpdate((event) => {
      if (!segment) return;
      const next = Math.min(max, Math.max(0, origin.get() + event.translationX));
      x.set(next);
      const i = Math.round(next / segment);
      if (i !== index.get()) {
        index.set(i);
        scheduleOnRN(enter, i);
      }
    })
    .onFinalize(() => {
      dragging.set(false);
      x.set(withTiming(index.get() * segment, { duration: 150 }));
    });
  const thumb = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() }],
  }));

  if (!segments) return null;
  return (
    <GestureDetector gesture={pan}>
      <View
        accessibilityRole="tablist"
        onLayout={({ nativeEvent }) => setTrack(nativeEvent.layout.width)}
        // Fill the accessory's height, so the highlight has equal space above and below.
        style={{ flex: 1, flexDirection: "row", minHeight: 40, padding: 4 }}
      >
        {track > 0 && (
          <Animated.View
            style={[
              {
                position: "absolute",
                top: 4,
                bottom: 4,
                left: 4,
                width: segment,
                borderRadius: 999,
                borderCurve: "continuous",
                backgroundColor: t.dark ? "#ffffff26" : "#0000001a",
              },
              thumb,
            ]}
          />
        )}
        {segments.titles.map((title, i) => (
          <Tooltip key={title} text={segments.descriptions?.[i]}>
            <Pressable
              accessibilityRole="tab"
              accessibilityLabel={tabLabel(title, segments.counts?.[i])}
              accessibilityState={{ selected: selected === i }}
              onPress={() => segments.onSelect(i)}
              style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
            >
              <TabLabel title={title} count={segments.counts?.[i]} selected={selected === i} small={count > 4} />
            </Pressable>
          </Tooltip>
        ))}
      </View>
    </GestureDetector>
  );
}

/** Compact desktop page switches share the section's filter/display toolbar. */
export function ToolbarTabs({ tabs }: { tabs: Segments }) {
  const t = useTheme();
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: "row", alignItems: "center", gap: 2, flexShrink: 1 }}>
      {tabs.titles.map((title, index) => (
        <Tooltip key={title} text={tabs.descriptions?.[index]}>
          <Pressable
            accessibilityRole="tab"
            accessibilityLabel={tabLabel(title, tabs.counts?.[index])}
            accessibilityState={{ selected: tabs.selected === index }}
            onPress={() => tabs.onSelect(index)}
            style={({ pressed }) => ({
              minHeight: 28,
              paddingHorizontal: 7,
              borderRadius: 6,
              justifyContent: "center",
              flexShrink: 1,
              backgroundColor: tabs.selected === index || pressed ? t.chip : "transparent",
            })}
          >
            <TabLabel title={title} count={tabs.counts?.[index]} selected={tabs.selected === index} compact />
          </Pressable>
        </Tooltip>
      ))}
    </View>
  );
}
