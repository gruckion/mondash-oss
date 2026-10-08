import type { Ref } from "react";
import { View } from "react-native";
import { useTheme } from "@/lib/theme";
import { TooltipButton } from "./tooltip-button";
import { Icon } from "./icon";
import { ConnectionWarningDot } from "./connection-indicators";

export function MoreMenuTrigger({
  ref,
  warning,
  onPress,
  expanded,
}: {
  ref?: Ref<View>;
  warning?: string;
  onPress?: () => void;
  expanded?: boolean;
}) {
  const t = useTheme();
  return (
    <TooltipButton
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={warning ? `More options, ${warning}` : "More options"}
      accessibilityState={expanded === undefined ? undefined : { expanded }}
      aria-haspopup="menu"
      tooltip={warning ?? "Filters, display, debriefs and settings"}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.5 : 1,
      })}
    >
      <Icon name="ellipsis" color={t.dark ? "#ffffff" : t.text} size={22} />
      {!!warning && <ConnectionWarningDot />}
    </TooltipButton>
  );
}
