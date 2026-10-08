import { TooltipButton as Pressable } from "./tooltip-button";
import { Icon } from "./icon";
import { router } from "expo-router";
import { Text, View } from "react-native";
import type { Card } from "@mondash/shared/contract";
import { useOpenSheet, type SessionGroup } from "@/lib/session-sheet";
import { latestSession } from "@/lib/latest-session";
import { ago, useTheme } from "@/lib/theme";
import { linearTicket, pullRequest } from "./start-review";

export function SessionsLink({ card }: { card: Card }) {
  return (
    <SessionSummary
      group={{
        id: card.id,
        label:
          card.kind === "scoping"
            ? "Scoping"
            : card.kind === "pr"
              ? card.subtitle
              : card.kind === "session"
                ? "Recent activity"
                : card.id,
        title: card.title,
        sessions: card.sessions,
        ticket: card.kind === "issue" ? linearTicket(card) : undefined,
        pr: pullRequest(card),
        review: card.kind === "review" && card.url ? card.url : undefined,
      }}
    />
  );
}

export function SessionSummary({ group }: { group: SessionGroup }) {
  const t = useTheme();
  const { setGroup } = useOpenSheet();
  const latest = latestSession(group.sessions);
  if (!latest) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Agent sessions, ${group.sessions.length}. Latest ${ago(latest.updatedAt)}. ${latest.title}`}
      accessibilityHint="Opens the agent sessions sheet"
      onPress={() => {
        setGroup(group);
        router.push("/agent-sessions");
      }}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        minHeight: 48,
        paddingVertical: 4,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Icon name="terminal" color={t.secondary} size={18} />
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={{ color: t.text, fontSize: 13, fontWeight: "500" }}>
          Agent sessions <Text style={{ color: t.secondary }}>· {group.sessions.length}</Text>
        </Text>
        <Text numberOfLines={1} style={{ color: t.secondary, fontSize: 12 }}>
          {ago(latest.updatedAt)} · {latest.title}
        </Text>
      </View>
      <Icon name="chevron.right" color={t.secondary} size={12} />
    </Pressable>
  );
}
