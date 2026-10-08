import { Text, View } from "react-native";
import { useTheme } from "@/lib/theme";
import { Icon } from "./icon";
import { SourceIcon } from "./web-icons";

export type MissingSource = "slack" | "github" | "linear" | "sessions";

const NAMES: Record<MissingSource, string> = {
  slack: "Slack threads",
  github: "pull requests",
  linear: "Linear tickets",
  sessions: "agent sessions",
};

/** A grey "None" for each kind of link a card has none of, so an empty card reads as checked, not broken. */
export function MissingLinks({ sources }: { sources: readonly MissingSource[] }) {
  const t = useTheme();
  if (sources.length === 0) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
      {sources.map((source) => (
        <View
          key={source}
          accessible
          accessibilityLabel={`No linked ${NAMES[source]}`}
          style={{ flexDirection: "row", alignItems: "center", gap: 5 }}
        >
          {source === "sessions" ? (
            <Icon name="terminal" color={t.secondary} size={14} />
          ) : (
            <SourceIcon source={source} size={14} />
          )}
          <Text style={{ color: t.secondary, fontSize: 12 }}>None</Text>
        </View>
      ))}
    </View>
  );
}
