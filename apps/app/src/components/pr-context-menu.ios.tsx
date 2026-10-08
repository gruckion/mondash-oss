import { useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { Link } from "expo-router";
import { useImage } from "expo-image";
import * as Clipboard from "expo-clipboard";
import { conflictsSvg } from "@mondash/shared/pr-icons";
import { useTheme } from "@/lib/theme";
import { openUrl } from "./ui";
import type { PRContextMenuProps } from "./pr-context-menu";

/** System context menu anchored to the pressed PR, with the ordinary GitHub link on tap. */
export function PRContextMenu({
  children,
  url,
  state,
  onFix,
  busy,
  style,
  onPressIn,
  onPressOut,
  ...props
}: PRContextMenuProps) {
  const t = useTheme();
  const conflictIcon = useImage(
    {
      uri: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(conflictsSvg(state, { secondary: t.secondary, unreviewed: t.secondary }, t.secondary))}`,
      width: 20,
      height: 20,
    },
    { maxWidth: 20, maxHeight: 20 },
    [state, t.secondary],
  );
  const [pressed, setPressed] = useState(false);
  // Link.Trigger merges style objects through a Slot. A Pressable callback is lost during that merge.
  const triggerStyle = StyleSheet.flatten(typeof style === "function" ? style({ pressed }) : style);
  if (!url)
    return (
      <Pressable {...props} style={style} onPressIn={onPressIn} onPressOut={onPressOut}>
        {children}
      </Pressable>
    );
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      <Link href={url} asChild>
        <Link.Trigger>
          <Pressable
            {...props}
            style={triggerStyle}
            onPress={undefined}
            onPressIn={(event) => {
              setPressed(true);
              onPressIn?.(event);
            }}
            onPressOut={(event) => {
              setPressed(false);
              onPressOut?.(event);
            }}
          >
            {children}
          </Pressable>
        </Link.Trigger>
        <Link.Menu>
          <Link.MenuAction icon="arrow.up.right" onPress={() => void openUrl(url)}>
            Open in GitHub
          </Link.MenuAction>
          <Link.MenuAction
            icon="link"
            onPress={() => {
              void Clipboard.setStringAsync(url).catch(() => Alert.alert("Could not copy link", "Try again."));
            }}
          >
            Copy Link
          </Link.MenuAction>
          {onFix && (
            <Link.MenuAction image={conflictIcon} imageRenderingMode="original" disabled={busy} onPress={onFix}>
              Fix Merge Conflict
            </Link.MenuAction>
          )}
        </Link.Menu>
      </Link>
    </View>
  );
}
