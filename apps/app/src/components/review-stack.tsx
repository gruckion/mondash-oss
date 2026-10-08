import { useMemo, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { Card, Group } from "@mondash/shared/contract";
import { reviewStackLayout } from "@mondash/shared/review-stacks";
import { useTheme } from "@/lib/theme";
import { cardScope } from "@mondash/shared/linked-items";
import { useAllHighlighted } from "@/lib/link-highlights";
import { HighlightBox } from "./linked-item";
import { StackCard, StackCardHeader } from "./stack-card";
import { PRStateIcon, prKeyFromUrl } from "./pr-row";
import { ReviewStackOthers } from "./review-stack-others";
import { openUrl } from "./ui";

export function ReviewStackGroup({ group, renderCard }: { group: Group; renderCard: (card: Card) => ReactNode }) {
  const t = useTheme();
  const layout = useMemo(() => reviewStackLayout(group.cards, group.reviewStacks), [group.cards, group.reviewStacks]);
  const items = useMemo(() => group.cards.map(cardScope), [group.cards]);
  const allHighlighted = useAllHighlighted(items);
  if (!group.cards.length) return null;
  if (!layout)
    return (
      <View>
        {group.cards.map((card) => (
          <View key={card.id}>{renderCard(card)}</View>
        ))}
      </View>
    );
  const { stack, layers, others } = layout;
  return (
    <StackCard>
      <StackCardHeader
        title={`${layout.repository.split("/").at(-1)} · Stack #${stack.number}`}
        detail={`${group.cards.length} to review · base ${stack.base}`}
      />
      <HighlightBox highlighted={allHighlighted} padding={0} gap={8}>
        {layers.map((layer) => (
          <View key={layer.cards[0].id} style={{ gap: 8 }}>
            <Text style={{ color: t.secondary, fontSize: 11, paddingHorizontal: 4 }}>
              {layer.position ? `Layer ${layer.position}/${stack.size}` : "Related PR"}
              {layer.cards.length > 1 ? ` · ${layer.cards.map((card) => card.prKey ?? card.id).join(" + ")}` : ""}
            </Text>
            {layer.cards.map((card) => (
              <View key={card.id}>{renderCard(card)}</View>
            ))}
          </View>
        ))}
      </HighlightBox>
      {!!others.length && (
        <View style={{ borderTopWidth: 1, borderTopColor: t.line }}>
          <ReviewStackOthers count={others.length}>
            {others.map((entry) => (
              <Pressable
                key={entry.url}
                accessibilityRole="link"
                accessibilityLabel={`${prKeyFromUrl(entry.url, `#${entry.number}`)}. ${entry.title}. ${entry.status}`}
                onPress={() => void openUrl(entry.url)}
                style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 12, minHeight: 52 }}
              >
                <PRStateIcon
                  state={
                    entry.status === "Draft"
                      ? "DRAFT"
                      : entry.status === "Merged"
                        ? "MERGED"
                        : entry.status === "Closed"
                          ? "CLOSED"
                          : "OPEN"
                  }
                  conflicts={entry.status === "Conflicts"}
                />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ color: t.text, fontSize: 13 }}>{entry.title}</Text>
                  <Text style={{ color: t.secondary, fontSize: 11 }}>
                    {prKeyFromUrl(entry.url, `#${entry.number}`)}
                  </Text>
                </View>
                <Text style={{ color: t.secondary, fontSize: 11 }}>{entry.status}</Text>
              </Pressable>
            ))}
          </ReviewStackOthers>
        </View>
      )}
      {stack.entries.length < stack.size && (
        <Text style={{ color: t.secondary, fontSize: 11, padding: 12 }}>Some stack members are unavailable.</Text>
      )}
    </StackCard>
  );
}
