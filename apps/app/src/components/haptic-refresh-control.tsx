import * as Haptics from "expo-haptics";
import type { ComponentProps } from "react";
import { Platform, RefreshControl } from "react-native";

/** iOS emits onRefresh as the pull crosses its native threshold, including while the finger is still down. */
export function HapticRefreshControl({ onRefresh, refreshing, ...props }: ComponentProps<typeof RefreshControl>) {
  return (
    <RefreshControl
      {...props}
      refreshing={refreshing}
      onRefresh={() => {
        if (!refreshing && Platform.OS === "ios") {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        }
        return onRefresh?.();
      }}
    />
  );
}
