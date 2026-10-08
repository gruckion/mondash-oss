import type { ComponentProps } from "react";
import { Pressable } from "react-native";
import { Tooltip } from "./tooltip";

/** Opt-in action control: reuse its accessible description as web hover help. */
export function TooltipButton({ tooltip, ...props }: ComponentProps<typeof Pressable> & { tooltip?: string | false }) {
  const text = tooltip === false ? undefined : (tooltip ?? props.accessibilityHint ?? props.accessibilityLabel);
  return (
    <Tooltip text={text}>
      <Pressable {...props} />
    </Tooltip>
  );
}
