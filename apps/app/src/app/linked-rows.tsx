import { TooltipButton } from "@/components/tooltip-button";
import { webScrollProps } from "@/lib/web-scroll";
import { Sheet } from "@/components/sheet";
import { Icon } from "@/components/icon";
import { router } from "expo-router";
import { ScrollView, Text, View } from "react-native";
import { DetailRow } from "@/components/card-details";
import { useSessionSheet } from "@/lib/session-sheet";
import { useTheme } from "@/lib/theme";

export default function LinkedRowsSheet() {
  const t = useTheme();
  const { rows: sheet } = useSessionSheet();
  return (
    <Sheet>
      <ScrollView
        {...webScrollProps}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 16,
          paddingBottom: 20,
          gap: 8,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Text accessibilityRole="header" style={{ flex: 1, color: t.text, fontSize: 20, fontWeight: "600" }}>
            {sheet ? `${sheet.heading} · ${sheet.rows.length}` : "Linked"}
          </Text>
          <TooltipButton
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={() => router.back()}
            style={{
              width: 44,
              height: 44,
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <Icon name="xmark.circle.fill" color={t.secondary} size={28} />
          </TooltipButton>
        </View>
        {sheet ? (
          <>
            <Text selectable numberOfLines={1} style={{ color: t.secondary, fontSize: 13, lineHeight: 18 }}>
              {sheet.title}
            </Text>
            {sheet.rows.map((row, i) => (
              <DetailRow key={`${row.url}-${i}`} row={row} onLinked={sheet.onLinked} />
            ))}
          </>
        ) : (
          <Text style={{ color: t.secondary, fontSize: 15, marginTop: 16 }}>
            Open merged PRs or Slack threads from a card.
          </Text>
        )}
      </ScrollView>
    </Sheet>
  );
}
