import { MenuView } from "@expo/ui/community/menu";
import { router } from "expo-router";
import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { MoreMenuTrigger } from "./more-menu-trigger";
import type { ViewSection } from "@mondash/shared/view-options";
import { moreMenuItems } from "./more-menu-items";
import { useProviderWarning } from "@/lib/use-provider-warning";

/** The same native, tap-to-expand menu used by ecosave-hub's attachment button. */
export function MoreMenu({ section }: { section: ViewSection }) {
  const warning = useProviderWarning();
  const items = moreMenuItems(section);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current);
    },
    [],
  );
  return (
    <MenuView
      style={{ width: 44, height: 44 }}
      actions={items.map((item) => ({
        id: item.id,
        title: item.title,
        image: Platform.OS === "ios" ? item.icon : undefined,
      }))}
      onPressAction={({ nativeEvent }) => {
        const href = items.find((item) => item.id === nativeEvent.event)?.href;
        if (!href) return;
        if (pending.current) clearTimeout(pending.current);
        // Let the system popup dismiss before presenting another UIKit screen.
        pending.current = setTimeout(() => router.push(href), 140);
      }}
    >
      <MoreMenuTrigger warning={warning} />
    </MenuView>
  );
}
