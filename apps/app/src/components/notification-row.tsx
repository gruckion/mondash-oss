import { useShows } from "@/lib/view-options";
import { Icon } from "./icon";
import { useEffect, useRef, useState } from "react";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { Platform, Pressable, Text, View } from "react-native";
import Swipeable, { type SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import Animated, {
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import type { CalendarEvent, Card } from "@mondash/shared/contract";
import { calendarEventPresentation } from "@mondash/shared/calendar-event";
import { useMarkRead } from "@/lib/provider";
import { ago, useTheme } from "@/lib/theme";
import { JevScore } from "./jev-score";
import { openUrl } from "./ui";
import { SourceIcon } from "./web-icons";

// How far to drag before letting go toggles read.
const THRESHOLD = 72;

const buzz = () => {
  if (Platform.OS !== "web") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
};

function CalendarPreview({ event }: { event: CalendarEvent }) {
  const t = useTheme();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const { when, status } = calendarEventPresentation(event, now);
  return (
    <View style={{ gap: 2 }}>
      <Text style={{ color: t.secondary, fontSize: 13, lineHeight: 18 }}>{when}</Text>
      <Text
        style={{
          color: status === "In progress" || status.startsWith("Starts in") ? t.accent : t.secondary,
          fontSize: 12,
          lineHeight: 18,
        }}
      >
        {status}
      </Text>
    </View>
  );
}

/** The blue action behind a row: hidden until you drag, one tap of haptics once letting go would toggle. */
function SwipeAction({
  translation,
  drag,
  unread,
}: {
  translation: SharedValue<number>;
  /** The row's copy of the drag, so it can round its corners. */
  drag: SharedValue<number>;
  unread: boolean;
}) {
  const t = useTheme();
  useAnimatedReaction(
    () => translation.value,
    (value) => {
      drag.set(value);
    },
  );
  useAnimatedReaction(
    () => translation.value >= THRESHOLD,
    (past, before) => {
      if (past && before === false) scheduleOnRN(buzz);
    },
  );
  const visible = useAnimatedStyle(() => ({
    opacity: translation.value > 0 ? 1 : 0,
  }));
  return (
    <Animated.View
      style={[
        {
          width: 150,
          backgroundColor: t.dark ? "#2f5f8f" : "#3478c6",
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 16,
        },
        visible,
      ]}
    >
      <Icon name={unread ? "envelope.open" : "envelope.badge"} color="#ffffff" size={18} />
      <Text style={{ color: "#ffffff", fontSize: 14, fontWeight: "600" }}>
        {unread ? "Mark as read" : "Mark unread"}
      </Text>
    </Animated.View>
  );
}

/**
 * One Inbox item: who did what, on what, and the words they used. Tapping opens it where it happened and marks it
 * read; swiping right toggles read, as in Slack. Read state lives on the Mac, not in Slack, GitHub or Linear.
 */
export function NotificationRow({
  card,
  last = false,
}: {
  card: Card;
  /** The last row in the list has no divider under it. */
  last?: boolean;
}) {
  const t = useTheme();
  const shows = useShows();
  const markRead = useMarkRead();
  const swipe = useRef<SwipeableMethods>(null);
  const drag = useSharedValue(0);
  // Corners round as soon as the row moves and square off once it is back.
  const rounded = useAnimatedStyle(() => ({
    borderRadius: withTiming(drag.value > 0 ? 14 : 0, { duration: 150 }),
  }));
  const unread = card.unread ?? false;
  const source = card.feedSource ?? "github";
  const actor = card.author;
  const hasActions = card.links.length > 0 || !!card.calendarEvent;
  const mark = (read: boolean) => markRead.mutate({ id: card.id, read });
  return (
    <Swipeable
      ref={swipe}
      leftThreshold={THRESHOLD}
      overshootLeft={false}
      // Full width, so the action reaches the screen edge; the row pads its own content.
      containerStyle={{ marginHorizontal: -16 }}
      onSwipeableOpen={() => {
        mark(unread);
        swipe.current?.close();
      }}
      renderLeftActions={(_progress, translation) => (
        <SwipeAction translation={translation} drag={drag} unread={unread} />
      )}
    >
      <Animated.View
        style={[
          {
            overflow: "hidden",
            borderCurve: "continuous",
            backgroundColor: t.background,
            borderBottomWidth: last ? 0 : 1,
            borderBottomColor: t.line,
          },
          rounded,
        ]}
      >
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={[actor?.name, card.status, card.title, card.subtitle].filter(Boolean).join(". ")}
          accessibilityState={{ selected: unread }}
          accessibilityHint={unread ? "Unread" : undefined}
          onPress={() => {
            if (unread) mark(true);
            if (card.url) void openUrl(card.url);
          }}
          style={({ pressed }) => ({
            flexDirection: "row",
            gap: 10,
            paddingVertical: 12,
            paddingBottom: hasActions ? 6 : 12,
            paddingHorizontal: 16,
            // Opaque, and darker rather than see-through when held, so the action never shows through.
            backgroundColor: pressed ? t.chip : t.background,
          })}
        >
          <View style={{ width: 32, height: 32 }}>
            {actor?.avatar ? (
              <Image source={actor.avatar} style={{ width: 32, height: 32, borderRadius: 16 }} />
            ) : (
              <View
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 16,
                  backgroundColor: t.dark ? "#2c2c2e" : "#e4e4e7",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text
                  style={{
                    color: t.secondary,
                    fontSize: 13,
                    fontWeight: "600",
                  }}
                >
                  {actor?.name.slice(0, 1) ?? "·"}
                </Text>
              </View>
            )}
            <View
              style={{
                position: "absolute",
                right: -4,
                bottom: -4,
                padding: 2,
                borderRadius: 8,
                backgroundColor: t.background,
              }}
            >
              <SourceIcon source={source} size={12} />
            </View>
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
              <Text numberOfLines={1} style={{ flex: 1, color: t.secondary, fontSize: 13 }}>
                {actor && (
                  <Text style={{ color: t.text, fontWeight: "600" }}>
                    {actor.name}
                    {card.calendarEvent ? " · " : " "}
                  </Text>
                )}
                {card.status}
              </Text>
              {card.jev !== undefined && shows("jev") && <JevScore value={card.jev} suffix="needs you" />}
              {card.updatedAt && (
                <Text
                  style={{
                    color: unread ? t.accent : t.secondary,
                    fontSize: 11,
                  }}
                >
                  {ago(card.updatedAt)}
                </Text>
              )}
              {unread && (
                <View
                  accessibilityLabel="Unread"
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: t.accent,
                    alignSelf: "center",
                  }}
                />
              )}
            </View>
            <Text
              numberOfLines={card.calendarEvent ? 2 : 1}
              style={{
                color: t.text,
                fontSize: 15,
                fontWeight: unread ? "700" : "400",
              }}
            >
              {card.title}
            </Text>
            {card.calendarEvent && shows("preview") ? (
              <CalendarPreview event={card.calendarEvent} />
            ) : (
              !!card.subtitle &&
              shows("preview") && (
                <Text numberOfLines={2} style={{ color: t.secondary, fontSize: 13, lineHeight: 18 }}>
                  {card.subtitle}
                </Text>
              )
            )}
          </View>
        </Pressable>
        {hasActions && (
          <View
            style={{
              paddingLeft: 58,
              paddingRight: 16,
              paddingBottom: 12,
              flexDirection: "row",
              flexWrap: "wrap",
              gap: 8,
            }}
          >
            {[...card.links, ...(card.url ? [{ title: "Open in Slack", url: card.url }] : [])].map((link, index) => (
              <Pressable
                key={`${link.title}-${link.url}`}
                accessibilityRole="link"
                accessibilityLabel={link.title}
                onPress={() => {
                  if (unread) mark(true);
                  void openUrl(link.url);
                }}
                style={({ pressed }) => ({
                  minHeight: 44,
                  justifyContent: "center",
                  paddingHorizontal: 10,
                  borderRadius: 8,
                  backgroundColor: index < card.links.length ? t.tint : "transparent",
                  opacity: pressed ? 0.65 : 1,
                })}
              >
                <Text style={{ color: t.accent, fontSize: 12, fontWeight: "600" }}>{link.title}</Text>
              </Pressable>
            ))}
          </View>
        )}
      </Animated.View>
    </Swipeable>
  );
}
