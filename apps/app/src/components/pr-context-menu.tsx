import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { Alert, Modal, Platform, Pressable, Text, View, useWindowDimensions } from "react-native";
import * as Clipboard from "expo-clipboard";
import { conflictsSvg, type PRState } from "@mondash/shared/pr-icons";
import { useTheme } from "@/lib/theme";
import { Icon } from "./icon";
import { useOpenUrl } from "./ui";
import { SvgIcon } from "./web-icons";

export type PRContextMenuProps = ComponentProps<typeof Pressable> & {
  url: string;
  state: PRState;
  onFix?: () => void;
  busy: boolean;
  onOpen?: () => void;
};

export function copyPRLink(url: string) {
  void Clipboard.setStringAsync(url).catch(() => Alert.alert("Could not copy link", "Try again."));
}

/** Long press on touch, right click or Shift+F10 on a desktop. iOS uses the native context menu. */
export function PRContextMenu({ children, url, state, onFix, busy, onOpen, ...props }: PRContextMenuProps) {
  const openUrl = useOpenUrl();
  const t = useTheme();
  const { width, height } = useWindowDimensions();
  const trigger = useRef<View>(null);
  const entries = useRef<(View | null)[]>([]);
  const focused = useRef(0);
  const [anchor, setAnchor] = useState<{ x: number; y: number }>();
  const items = useMemo(
    () => [
      { title: "Open in GitHub", icon: "arrow.up.right", action: onOpen ?? (() => void openUrl(url)), disabled: false },
      { title: "Copy Link", icon: "link", action: () => copyPRLink(url), disabled: false },
      ...(onFix
        ? [
            {
              title: "Fix Merge Conflict",
              icon: (
                <SvgIcon
                  svg={conflictsSvg(state, { secondary: t.secondary, unreviewed: t.secondary }, t.secondary)}
                  size={20}
                />
              ),
              action: onFix,
              disabled: busy,
            },
          ]
        : []),
    ],
    [url, state, onFix, busy, onOpen, openUrl, t.secondary],
  );
  const open = useCallback(() => trigger.current?.measureInWindow((x, y) => setAnchor({ x, y })), []);
  const close = useCallback(() => {
    setAnchor(undefined);
    if (Platform.OS === "web")
      (trigger.current as unknown as HTMLElement | null)?.querySelector<HTMLElement>('[role="link"]')?.focus();
  }, []);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const node = trigger.current as unknown as HTMLElement | null;
    const context = (event: MouseEvent) => {
      event.preventDefault();
      setAnchor({ x: event.clientX, y: event.clientY });
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        open();
      }
    };
    node?.addEventListener("contextmenu", context);
    node?.addEventListener("keydown", keyboard);
    return () => {
      node?.removeEventListener("contextmenu", context);
      node?.removeEventListener("keydown", keyboard);
    };
  }, [open]);
  useEffect(() => {
    if (!anchor || Platform.OS !== "web") return;
    const timer = setTimeout(() => entries.current[0]?.focus(), 100);
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopImmediatePropagation();
        const item = items[focused.current];
        if (item && !item.disabled) {
          close();
          item.action();
        }
      } else if (event.key === "Escape") {
        event.preventDefault();
        close();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        let next = focused.current;
        do {
          next = (next + step + items.length) % items.length;
        } while (items[next].disabled);
        entries.current[next]?.focus();
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        const enabled = items.map((item, index) => (item.disabled ? -1 : index)).filter((index) => index >= 0);
        entries.current[event.key === "Home" ? enabled[0] : enabled.at(-1)!]?.focus();
      }
    };
    window.addEventListener("keydown", keyboard, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", keyboard, true);
    };
  }, [anchor, items, close]);
  const menuWidth = Math.min(252, width - 24);
  if (!url) return <Pressable {...props}>{children}</Pressable>;
  return (
    <View ref={trigger} style={{ flex: 1, minWidth: 0 }}>
      <Pressable {...props} onLongPress={open}>
        {children}
      </Pressable>
      <Modal transparent visible={!!anchor} animationType="fade" onRequestClose={close}>
        <View style={{ flex: 1 }}>
          <Pressable
            accessibilityLabel="Dismiss pull request menu"
            onPress={close}
            style={{ position: "absolute", inset: 0 }}
          />
          {anchor && (
            <View
              accessibilityRole="menu"
              accessibilityLabel="Pull request options"
              style={{
                position: "absolute",
                left: Math.max(12, Math.min(anchor.x, width - menuWidth - 12)),
                top: Math.max(12, Math.min(anchor.y, height - items.length * 48 - 24)),
                width: menuWidth,
                padding: 6,
                borderRadius: 16,
                backgroundColor: t.dark ? "#1c1c1e" : "#fff",
                borderWidth: 1,
                borderColor: t.line,
                boxShadow: "0 8px 24px rgba(0,0,0,0.2)",
              }}
            >
              {items.map((item, index) => (
                <Pressable
                  key={item.title}
                  ref={(entry) => {
                    entries.current[index] = entry;
                  }}
                  accessibilityRole="menuitem"
                  disabled={item.disabled}
                  onFocus={() => {
                    focused.current = index;
                  }}
                  onPress={() => {
                    close();
                    item.action();
                  }}
                  style={({ pressed }) => ({
                    minHeight: 48,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 12,
                    paddingHorizontal: 12,
                    borderRadius: 10,
                    opacity: item.disabled ? 0.4 : 1,
                    backgroundColor: pressed ? t.line : "transparent",
                  })}
                >
                  {typeof item.icon === "string" ? <Icon name={item.icon} size={20} color={t.text} /> : item.icon}
                  <Text style={{ color: t.text, fontSize: 15 }}>{item.title}</Text>
                </Pressable>
              ))}
            </View>
          )}
        </View>
      </Modal>
    </View>
  );
}
