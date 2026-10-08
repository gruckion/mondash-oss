import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PRStack } from "@mondash/shared/contract";
import { useTheme } from "@/lib/theme";
import { Icon } from "./icon";
import { useOpenUrl } from "./ui";

/** A quiet stack badge expands into GitHub's ordered PR chain and individual merge blockers. */
export function PRStackDetails({ stack, url }: { stack: PRStack; url?: string }) {
  const openUrl = useOpenUrl();
  const t = useTheme();
  const [expanded, setExpanded] = useState(false);
  const incomplete = stack.entries.length < stack.size;
  const blocked = stack.entries.some((entry) => !["Ready", "Merged", "Checking"].includes(entry.status));
  const color = blocked ? t.warning : t.secondary;
  return (
    <View style={{ marginTop: 6 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Stack #${stack.number}, PR ${stack.position} of ${stack.size}${blocked ? ", merge blocked" : ""}`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          alignSelf: "flex-start",
          paddingHorizontal: 9,
          minHeight: 32,
          borderRadius: 8,
          backgroundColor: pressed || expanded ? t.chip : "transparent",
        })}
      >
        <Icon name="square.stack.3d.up" size={14} color={color} />
        <Text style={{ color, fontSize: 12, fontWeight: "500", fontVariant: ["tabular-nums"] }}>
          {stack.position}/{stack.size}
        </Text>
        <Text style={{ color: t.secondary, fontSize: 12 }}>Stack #{stack.number}</Text>
        {blocked && <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: t.warning }} />}
        <View style={{ transform: [{ rotate: expanded ? "90deg" : "0deg" }] }}>
          <Icon name="chevron.right" size={10} color={t.secondary} />
        </View>
      </Pressable>
      {expanded && (
        <View
          style={{
            marginTop: 6,
            borderRadius: 12,
            borderCurve: "continuous",
            borderWidth: 1,
            borderColor: t.line,
            padding: 8,
            backgroundColor: t.background,
          }}
        >
          {[...stack.entries].reverse().map((entry) => {
            const current = entry.position === stack.position;
            const tone =
              entry.status === "Ready" || entry.status === "Merged"
                ? "#30a46c"
                : entry.status === "Checking"
                  ? t.secondary
                  : t.warning;
            return (
              <Pressable
                key={entry.position}
                accessibilityRole="link"
                accessibilityLabel={`#${entry.number}. ${entry.title}. ${entry.status}`}
                onPress={() => void openUrl(entry.url)}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  padding: 10,
                  minHeight: 52,
                  borderRadius: 8,
                  backgroundColor: current ? t.tint : pressed ? t.chip : "transparent",
                })}
              >
                <Icon name="review.branch" size={17} color={tone} />
                <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                  <Text
                    numberOfLines={1}
                    ellipsizeMode="tail"
                    style={{ color: t.text, fontSize: 13, fontWeight: current ? "600" : "400" }}
                  >
                    {entry.title}
                  </Text>
                  <Text style={{ color: t.secondary, fontSize: 11 }}>#{entry.number}</Text>
                </View>
                <View style={{ borderRadius: 999, paddingHorizontal: 7, paddingVertical: 4, backgroundColor: t.chip }}>
                  <Text style={{ color: tone, fontSize: 10, fontWeight: "500" }}>{entry.status}</Text>
                </View>
              </Pressable>
            );
          })}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 10 }}>
            <View
              style={{
                width: 7,
                height: 7,
                marginHorizontal: 5,
                borderRadius: 4,
                borderWidth: 1.5,
                borderColor: t.secondary,
              }}
            />
            <Text numberOfLines={1} style={{ color: t.secondary, fontSize: 12, flex: 1 }}>
              {stack.base}
            </Text>
            {url && (
              <Pressable
                accessibilityRole="link"
                accessibilityLabel="View stack on GitHub"
                onPress={() => void openUrl(url)}
                hitSlop={8}
              >
                <Icon name="arrow.up.right" size={13} color={t.secondary} />
              </Pressable>
            )}
          </View>
          {incomplete && (
            <Text style={{ color: t.secondary, fontSize: 11, padding: 10 }}>
              Some PRs are unavailable · View the full stack on GitHub
            </Text>
          )}
        </View>
      )}
    </View>
  );
}
