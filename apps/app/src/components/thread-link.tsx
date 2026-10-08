import { TooltipButton as Pressable } from "./tooltip-button";
import { useState } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { linkThread } from "@/lib/api";
import { useSettings } from "@/lib/provider";
import { useTheme } from "@/lib/theme";
import { errorMessage } from "./ui";

/** The discovered thread supplies its own URL, just like the web's LinkButton. */
export function ThreadLink({ ticketId, url, onLinked }: { ticketId: string; url: string; onLinked: () => void }) {
  const { server } = useSettings();
  const t = useTheme();
  // Jev's score when it was unsure; the next tap links anyway.
  const [score, setScore] = useState<number>();
  const link = useMutation({
    mutationFn: (force: boolean) => linkThread(server, ticketId, url, force),
    onSuccess: (result) => {
      if (result.status === "confirm") setScore(result.score);
      else onLinked();
    },
  });
  const pending = link.isPending;
  const linked = link.data !== undefined && link.data.status !== "confirm";
  const error = link.error ? errorMessage(link.error) : undefined;
  function submit() {
    if (pending || linked) return;
    link.mutate(score !== undefined);
  }
  const label = linked
    ? "linked"
    : pending
      ? "checking…"
      : score !== undefined
        ? `Jev ${Math.round(score * 100)}% sure · link anyway`
        : "not linked · link";
  const color = linked ? "#16a34a" : t.dark ? "#fbbf24" : "#b45309";
  return (
    <View style={{ maxWidth: "100%" }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: this Slack conversation to ${ticketId}`}
        accessibilityState={{ disabled: pending || linked, busy: pending }}
        disabled={pending || linked}
        onPress={submit}
        hitSlop={6}
        style={{
          minHeight: 32,
          justifyContent: "center",
          opacity: pending ? 0.6 : 1,
        }}
      >
        <Text
          style={{
            color,
            alignSelf: "flex-start",
            backgroundColor: linked ? "#16a34a1a" : "#f59e0b1a",
            borderRadius: 6,
            borderWidth: linked ? 0 : 1,
            borderStyle: "dashed",
            borderColor: color,
            paddingHorizontal: 7,
            paddingVertical: 4,
            fontSize: 12,
            fontWeight: "500",
          }}
        >
          {label}
        </Text>
      </Pressable>
      {error && (
        <Text selectable accessibilityRole="alert" style={{ color: t.dark ? "#f87171" : "#b91c1c", fontSize: 12 }}>
          {error}
        </Text>
      )}
    </View>
  );
}
