import { ActivityIndicator, Text, View } from "react-native";
import { useTheme } from "@/lib/theme";
import { Icon } from "./icon";

/** Quiet on healthy rows; a short, accessible badge for a service that needs attention. */
export function ConnectionStatus({
  state,
  label,
}: {
  state: "connected" | "not-connected" | "error" | "unknown" | "off" | "setup";
  label: string;
}) {
  const t = useTheme();
  const failure = state === "not-connected" || state === "error";
  const color =
    state === "connected"
      ? t.dark
        ? "#4ade80"
        : "#15803d"
      : failure
        ? t.dark
          ? "#ffaaa3"
          : "#b42318"
        : state === "setup"
          ? t.warning
          : t.secondary;
  const background =
    state === "connected"
      ? t.dark
        ? "#142b1b"
        : "#e8f7ec"
      : failure
        ? t.dark
          ? "#361b1a"
          : "#ffedeb"
        : state === "setup"
          ? t.dark
            ? "#302415"
            : "#fff4db"
          : t.chip;
  return (
    <View
      accessible
      accessibilityLabel={label}
      style={{
        alignSelf: "flex-start",
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        paddingHorizontal: 8,
        paddingVertical: 5,
        borderRadius: 20,
        backgroundColor: background,
      }}
    >
      {state === "unknown" ? (
        <ActivityIndicator size="small" color={color} />
      ) : failure || state === "setup" ? (
        <Icon name="exclamationmark.circle" color={color} size={13} />
      ) : state === "connected" ? (
        <Icon name="checkmark" color={color} size={13} />
      ) : null}
      <Text style={{ color, fontSize: 12, fontWeight: "500" }}>{label}</Text>
    </View>
  );
}
