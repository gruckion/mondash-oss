import { router } from "expo-router";
import { Pressable, View } from "react-native";
import { Image } from "expo-image";
import { problemTitle, type ProviderProblem } from "@/lib/provider-health";
import { useTheme } from "@/lib/theme";
import { SourceIcon } from "./web-icons";

function ProviderIcon({ connection }: { connection: ProviderProblem }) {
  return connection.name === "claude" || connection.name === "codex" ? (
    <Image
      source={
        connection.name === "claude"
          ? require("../../assets/claude-symbol.svg")
          : require("../../assets/codex-logo.png")
      }
      contentFit="contain"
      style={{ width: 18, height: 18 }}
    />
  ) : (
    <SourceIcon source={connection.name} size={18} />
  );
}

/** A single Settings shortcut, with overlapping service icons and one warning dot. */
export function ConnectionIndicators({ problems }: { problems: readonly ProviderProblem[] }) {
  if (!problems.length) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${problems.map(problemTitle).join(", ")}. Open Settings`}
      onPress={() => router.push("/settings")}
      hitSlop={6}
      style={{
        width: Math.max(44, 38 + (problems.length - 1) * 14),
        height: 44,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ flexDirection: "row", alignItems: "center" }}
      >
        {problems.map((connection, index) => (
          <View
            key={connection.name}
            style={{
              width: 26,
              height: 26,
              marginLeft: index ? -12 : 0,
              alignItems: "center",
              justifyContent: "center",
              zIndex: index,
            }}
          >
            <ProviderIcon connection={connection} />
          </View>
        ))}
      </View>
      <ConnectionWarningDot />
    </Pressable>
  );
}

export function ConnectionWarningDot({ onIcon = false }: { onIcon?: boolean } = {}) {
  const t = useTheme();
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        top: onIcon ? -1 : 7,
        right: onIcon ? -1 : 7,
        width: 9,
        height: 9,
        borderRadius: 5,
        backgroundColor: "#ff3b30",
        borderWidth: 1.5,
        borderColor: t.background,
      }}
    />
  );
}
