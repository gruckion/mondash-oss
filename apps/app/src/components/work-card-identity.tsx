import { Pressable, Text, View } from "react-native";
import type { Card } from "@mondash/shared/contract";
import { ago, useTheme } from "@/lib/theme";
import { useShows } from "@/lib/view-options";
import { Metadata } from "./card-metadata";
import { ReplyLip, isReplyBadge } from "./reply-lip";
import { SourceIcon } from "./web-icons";
import { useOpenUrl } from "./ui";

/** The same issue/scope identity and metadata in Work and Activity's linked work. */
export function WorkCardIdentity({ card, onOpen }: { card: Card; onOpen?: () => void }) {
  const openUrl = useOpenUrl();
  const t = useTheme();
  const shows = useShows();
  const kind = card.kind;
  const doc = kind === "scoping" ? card.rows?.find((row) => row.kind === "notion" && row.url === card.url) : undefined;
  const badges = card.badges ?? [];
  const replies = badges.filter(isReplyBadge);
  const metadataBadges =
    kind === "scoping" ? badges.filter((badge) => badge.tone === "neutral" && !!badge.people?.length) : [];
  const title = (
    <Text
      selectable={!card.url}
      numberOfLines={1}
      ellipsizeMode="tail"
      style={{
        color: t.text,
        fontSize: 16,
        lineHeight: 22,
        fontWeight: kind === "issue" || kind === "scoping" ? "500" : "400",
        flexShrink: 1,
      }}
    >
      {card.title}
    </Text>
  );
  return kind === "issue" ? (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={card.title}
          disabled={!card.url}
          onPress={onOpen ?? (() => card.url && void openUrl(card.url))}
          hitSlop={{ top: 6, bottom: 6 }}
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 32,
            flexDirection: "row",
            alignItems: "center",
            gap: 7,
          }}
        >
          <SourceIcon source="linear" size={18} />
          {title}
        </Pressable>
        <View style={{ alignItems: "flex-end", flexShrink: 0 }}>
          <Text selectable style={{ color: t.secondary, fontSize: 10, lineHeight: 12 }}>
            {card.id}
          </Text>
          {(card.assigned?.at ?? card.updatedAt) && (
            <Text style={{ color: t.secondary, fontSize: 10, lineHeight: 12 }}>
              {ago((card.assigned?.at ?? card.updatedAt)!)}
            </Text>
          )}
        </View>
      </View>
      <View>
        <Metadata card={card} badges={metadataBadges} />
        {shows("replies") && <ReplyLip badges={replies} />}
      </View>
    </View>
  ) : (
    <View style={{ gap: 4 }}>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={card.title}
        onPress={onOpen ?? (() => card.url && void openUrl(card.url))}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 7,
          minHeight: 32,
        }}
      >
        <SourceIcon source="notion" />
        <View style={{ flex: 1, minWidth: 0 }}>{title}</View>
        {(!!doc?.createdAt || !!doc?.updatedAt) && (
          <View style={{ alignItems: "flex-end", flexShrink: 0 }}>
            {!!doc.createdAt && (
              <Text style={{ color: t.secondary, fontSize: 10, lineHeight: 12 }}>Created {ago(doc.createdAt)}</Text>
            )}
            {!!doc.updatedAt && (
              <Text style={{ color: t.secondary, fontSize: 10, lineHeight: 12 }}>Edited {ago(doc.updatedAt)}</Text>
            )}
          </View>
        )}
      </Pressable>
      <View>
        <Metadata card={card} badges={metadataBadges} doc={doc} />
        {shows("replies") && <ReplyLip badges={replies} />}
      </View>
    </View>
  );
}
