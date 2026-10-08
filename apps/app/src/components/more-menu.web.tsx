import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Modal, Pressable, Text, View, useWindowDimensions } from "react-native";
import Animated, { Keyframe } from "react-native-reanimated";
import { useTheme } from "@/lib/theme";
import { ConnectionWarningDot } from "./connection-indicators";
import { Icon } from "./icon";
import { MoreMenuTrigger } from "./more-menu-trigger";
import type { ViewSection } from "@mondash/shared/view-options";
import { moreMenuItems } from "./more-menu-items";
import { useProviderWarning } from "@/lib/use-provider-warning";

const expand = new Keyframe({
  0: { opacity: 0, transform: [{ translateY: -4 }, { scale: 0.85 }] },
  100: { opacity: 1, transform: [{ translateY: 0 }, { scale: 1 }] },
}).duration(140);

/** Browser counterpart: expand below the trigger, preserving the current route. */
export function MoreMenu({ section }: { section: ViewSection }) {
  const warning = useProviderWarning();
  const items = moreMenuItems(section);
  const t = useTheme();
  const { width, height } = useWindowDimensions();
  const trigger = useRef<View>(null);
  const entries = useRef<(View | null)[]>([]);
  const focused = useRef(0);
  const [anchor, setAnchor] = useState<{ x: number; y: number; width: number; height: number }>();
  const close = () => {
    setAnchor(undefined);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  useEffect(() => {
    const onResize = () => setAnchor(undefined);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => {
    if (!anchor) return;
    // The web Modal's focus trap activates after onShow; focus once its opening animation has settled.
    const focusTimer = setTimeout(() => entries.current[0]?.focus(), 180);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        // Consume activation before Pressable registers keyup against a disappearing menu item.
        event.preventDefault();
        event.stopImmediatePropagation();
        setAnchor(undefined);
        const item = moreMenuItems(section)[focused.current];
        if (item) router.push(item.href);
      } else if (event.key === "Escape") {
        event.preventDefault();
        setAnchor(undefined);
        trigger.current?.focus();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const count = moreMenuItems(section).length;
        entries.current[(focused.current + (event.key === "ArrowDown" ? 1 : -1) + count) % count]?.focus();
      } else if (event.key === "Home") {
        event.preventDefault();
        entries.current[0]?.focus();
      } else if (event.key === "End") {
        event.preventDefault();
        entries.current[moreMenuItems(section).length - 1]?.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(focusTimer);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [anchor, section]);
  const menuWidth = Math.min(248, width - 24);
  return (
    <>
      <MoreMenuTrigger
        warning={warning}
        ref={trigger}
        expanded={!!anchor}
        onPress={() => {
          if (anchor) return close();
          trigger.current?.measureInWindow((x, y, measuredWidth, measuredHeight) =>
            setAnchor({ x, y, width: measuredWidth, height: measuredHeight }),
          );
        }}
      />
      <Modal transparent visible={!!anchor} animationType="none" onRequestClose={close}>
        <View style={{ flex: 1 }}>
          <View
            accessible={false}
            onStartShouldSetResponder={() => true}
            onResponderRelease={close}
            style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
          />
          {anchor && (
            <Animated.View
              accessibilityRole="menu"
              accessibilityLabel="More options"
              entering={expand}
              style={{
                position: "absolute",
                left: Math.max(12, Math.min(anchor.x + anchor.width - menuWidth, width - menuWidth - 12)),
                top: Math.max(8, Math.min(anchor.y + anchor.height + 6, height - items.length * 48 - 24)),
                width: menuWidth,
                padding: 6,
                borderRadius: 18,
                borderCurve: "continuous",
                backgroundColor: t.dark ? "#1c1c1e" : "#ffffff",
                borderWidth: 1,
                borderColor: t.line,
                boxShadow: "0 8px 24px rgba(0,0,0,0.2)",
                transformOrigin: "top right",
              }}
            >
              {items.map((item, index) => (
                <Pressable
                  key={item.title}
                  ref={(entry) => {
                    entries.current[index] = entry;
                  }}
                  accessibilityRole="menuitem"
                  onFocus={() => {
                    focused.current = index;
                  }}
                  accessibilityLabel={item.id === "settings" && warning ? `Settings, ${warning}` : item.title}
                  onPress={() => {
                    close();
                    router.push(item.href);
                  }}
                  style={({ pressed }) => ({
                    minHeight: 48,
                    paddingHorizontal: 12,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 12,
                    borderRadius: 12,
                    backgroundColor: pressed ? t.line : "transparent",
                  })}
                >
                  <View style={{ width: 24, height: 24, alignItems: "center", justifyContent: "center" }}>
                    <Icon name={item.icon} color={t.text} size={21} />
                    {item.id === "settings" && !!warning && <ConnectionWarningDot onIcon />}
                  </View>
                  <Text style={{ flex: 1, color: t.text, fontSize: 16 }}>{item.title}</Text>
                </Pressable>
              ))}
            </Animated.View>
          )}
        </View>
      </Modal>
    </>
  );
}
