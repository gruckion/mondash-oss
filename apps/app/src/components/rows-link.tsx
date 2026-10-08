import { TooltipButton as Pressable } from "./tooltip-button";
import { Icon } from "./icon";
import type { ReactNode } from "react";
import { router } from "expo-router";
import { Text, View } from "react-native";
import type { Card, Row } from "@mondash/shared/contract";
import { useOpenSheet } from "@/lib/session-sheet";
import { ago, useTheme } from "@/lib/theme";

/** Rows a card keeps out of the way (merged/closed PRs, Slack threads): one summary opens them in a sheet. */
export function RowsLink({
  card,
  title: groupTitle,
  rows,
  heading,
  icon,
  onLinked,
}: {
  card?: Pick<Card, "id" | "title">;
  /** Shared stacks name every member; they do not borrow one ticket's identity. */
  title?: string;
  rows: readonly Row[];
  heading: string;
  icon: ReactNode;
  onLinked: () => void;
}) {
  const t = useTheme();
  const { setRows } = useOpenSheet();
  const at = (row: Row) => (row.updatedAt ? Date.parse(row.updatedAt) : 0);
  // Hermes has no Array.prototype.toSorted.
  const latest = rows.reduce<Row | undefined>((best, row) => (!best || at(row) > at(best) ? row : best), undefined);
  if (!latest) return null;
  const title = latest.kind === "pr" && latest.subtitle ? latest.subtitle : latest.title;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${heading}, ${rows.length}. Latest: ${title}`}
      accessibilityHint={`Opens the ${heading.toLowerCase()} sheet`}
      onPress={() => {
        setRows({
          heading,
          title: groupTitle ?? (card ? `${card.id} · ${card.title}` : heading),
          rows,
          onLinked,
        });
        router.push("/linked-rows");
      }}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        minHeight: 44,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      {icon}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: t.text, fontSize: 13, fontWeight: "500" }}>
          {heading} <Text style={{ color: t.secondary }}>· {rows.length}</Text>
        </Text>
        <Text numberOfLines={1} style={{ color: t.secondary, fontSize: 12 }}>
          {latest.updatedAt ? `${ago(latest.updatedAt)} · ` : ""}
          {title}
        </Text>
      </View>
      <Icon name="chevron.right" color={t.secondary} size={12} />
    </Pressable>
  );
}
