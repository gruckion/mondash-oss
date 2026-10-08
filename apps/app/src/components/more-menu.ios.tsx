import { Button, Host, Image, Label, Menu, RNHostView } from "@expo/ui/swift-ui";
import { accessibilityLabel } from "@expo/ui/swift-ui/modifiers";
import { router, type Href } from "expo-router";
import { useEffect, useRef } from "react";
import { Image as RNImage } from "react-native";
import { useTheme } from "@/lib/theme";
import { MoreMenuTrigger } from "./more-menu-trigger";
import type { ViewSection } from "@mondash/shared/view-options";
import { moreMenuItems } from "./more-menu-items";
import { useProviderWarning } from "@/lib/use-provider-warning";

/** MenuView's underlying native menu, with a full-color icon for Settings' warning dot. */
export function MoreMenu({ section }: { section: ViewSection }) {
  const warning = useProviderWarning();
  const t = useTheme();
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current);
    },
    [],
  );
  const open = (href: Href) => {
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => router.push(href), 140);
  };
  const warningIcon = RNImage.resolveAssetSource(
    t.dark ? require("../../assets/settings-warning-dark.png") : require("../../assets/settings-warning-light.png"),
  ).uri;
  return (
    <Host matchContents style={{ width: 44, height: 44 }} ignoreSafeArea="all">
      <Menu
        label={
          <RNHostView matchContents>
            <MoreMenuTrigger warning={warning} />
          </RNHostView>
        }
      >
        {moreMenuItems(section).map((item) =>
          item.id === "settings" ? (
            <Button
              key={item.id}
              onPress={() => open(item.href)}
              modifiers={warning ? [accessibilityLabel(`Settings, ${warning}`)] : undefined}
            >
              {warning ? (
                <Label title="Settings" icon={<Image uiImage={warningIcon} size={24} />} />
              ) : (
                <Label title="Settings" systemImage="gearshape" />
              )}
            </Button>
          ) : (
            <Button key={item.id} label={item.title} systemImage={item.icon} onPress={() => open(item.href)} />
          ),
        )}
      </Menu>
    </Host>
  );
}
