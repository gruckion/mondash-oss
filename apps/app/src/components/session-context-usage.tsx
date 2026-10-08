import { Text, View } from "react-native";
import type { SessionContextUsage as Usage } from "@mondash/shared/contract";
import { useTheme } from "@/lib/theme";
import { Tooltip } from "./tooltip";

/** Labelled separately from Jev's matching confidence. Shared by every session row. */
export function SessionContextUsage({ usage }: { usage?: Usage }) {
  const t = useTheme();
  const percent = usage?.windowTokens ? (usage.usedTokens / usage.windowTokens) * 100 : undefined;
  const value = usage
    ? `${tokens(usage.usedTokens)} / ${usage.windowTokens ? tokens(usage.windowTokens) : "?"}${percent === undefined ? "" : ` · ${Math.round(percent)}%`}`
    : "—";
  const label = usage
    ? `Context: ${usage.usedTokens.toLocaleString()}${usage.windowTokens ? ` of ${usage.windowTokens.toLocaleString()}` : ""} tokens used${percent === undefined ? "" : `, ${Math.round(percent)}% full`}. Latest recorded usage.${usage.windowTokens ? "" : " Window capacity unavailable."}`
    : "Context usage unavailable for this session.";
  return (
    <Tooltip text={label}>
      <View
        accessible
        accessibilityLabel={label}
        style={{ backgroundColor: t.chip, borderRadius: 5, overflow: "hidden", flexShrink: 0 }}
      >
        {percent !== undefined && (
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: 0,
              width: `${Math.min(100, percent)}%`,
              backgroundColor: t.accent,
              opacity: 0.22,
              borderRightWidth: 1,
              borderRightColor: t.accent,
            }}
          />
        )}
        <Text
          style={{
            color: t.text,
            fontSize: 11,
            lineHeight: 16,
            paddingHorizontal: 6,
            paddingVertical: 2,
            fontVariant: ["tabular-nums"],
          }}
        >
          Context {value}
        </Text>
      </View>
    </Tooltip>
  );
}

function tokens(count: number): string {
  if (count >= 1000000) return `${Number((count / 1000000).toFixed(1))}M`;
  if (count >= 1000) return `${Math.round(count / 1000)}K`;
  return String(count);
}
