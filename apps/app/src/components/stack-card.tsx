import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { useTheme } from "@/lib/theme";
import { Icon } from "./icon";

/** The same layered card shell for ticket stacks and GitHub review stacks. */
export function StackCard({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ paddingTop: 18, paddingBottom: 12 }}>
      {[0, 1].map((i) => (
        <View
          key={i}
          pointerEvents="none"
          accessible={false}
          style={{
            position: "absolute",
            top: i * 6 + 6,
            left: 12 - i * 6,
            right: 12 - i * 6,
            height: 24,
            borderWidth: 1,
            borderColor: t.line,
            backgroundColor: t.chip,
            borderRadius: 12,
          }}
        />
      ))}
      <View
        style={{
          backgroundColor: t.background,
          borderWidth: 1,
          borderColor: t.line,
          borderRadius: 12,
          overflow: "hidden",
          padding: 8,
          gap: 8,
        }}
      >
        {children}
      </View>
    </View>
  );
}

export function StackCardHeader({ title, detail }: { title: string; detail?: string }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, padding: 4 }}>
      <Icon name="square.stack.3d.up" color={t.secondary} size={16} />
      <Text accessibilityRole="header" style={{ color: t.text, fontSize: 13, fontWeight: "600" }}>
        {title}
      </Text>
      {detail && <Text style={{ color: t.secondary, fontSize: 12 }}>{detail}</Text>}
    </View>
  );
}
