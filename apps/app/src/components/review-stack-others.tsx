import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useTheme } from "@/lib/theme";
import { Icon } from "./icon";

export function ReviewStackOthers({ count, children }: { count: number; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const t = useTheme();
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44, paddingHorizontal: 12 }}
      >
        <View style={{ transform: [{ rotate: expanded ? "90deg" : "0deg" }] }}>
          <Icon name="chevron.right" size={11} color={t.secondary} />
        </View>
        <Text style={{ color: t.secondary, fontSize: 13 }}>
          {count} other PR{count === 1 ? "" : "s"}
        </Text>
      </Pressable>
      {expanded && children}
    </View>
  );
}
