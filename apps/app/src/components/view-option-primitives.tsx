import type { ReactNode } from "react";
import { Pressable, Text, View, type ViewStyle } from "react-native";
import { router } from "expo-router";
import { useTheme } from "@/lib/theme";
import { TooltipButton } from "./tooltip-button";
import { Icon } from "./icon";
import { Tip } from "./tip";

/** A rounded block of rows, as in Notion's view menus. */
export function Block({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <View
      style={{
        backgroundColor: t.dark ? "#1c1c1e" : "#f4f4f5",
        borderRadius: 12,
        overflow: "hidden",
      }}
    >
      {children}
    </View>
  );
}

export function Row({
  title,
  label,
  about,
  detail,
  onPress,
  checked,
  switchOn,
  chevron = false,
  last = false,
  trailing,
}: {
  title: string;
  /** Drawn in place of the title: a value as the cards draw it. */
  label?: ReactNode;
  /** What the row means, behind an (i). */
  about?: string;
  detail?: string;
  onPress?: () => void;
  checked?: boolean;
  switchOn?: boolean;
  chevron?: boolean;
  last?: boolean;
  trailing?: ReactNode;
}) {
  const t = useTheme();
  const selected = switchOn ?? checked;
  return (
    <Pressable
      accessibilityRole={switchOn !== undefined ? "switch" : checked === undefined ? "button" : "checkbox"}
      accessibilityLabel={title}
      accessibilityState={selected === undefined ? undefined : { checked: selected }}
      aria-checked={selected}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        minHeight: 48,
        paddingHorizontal: 14,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: t.line,
        backgroundColor: pressed ? t.line : "transparent",
      })}
    >
      <View
        style={{
          flex: 1,
          minWidth: 0,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
        }}
      >
        {label ?? (
          <Text numberOfLines={1} style={{ flexShrink: 1, color: t.text, fontSize: 15 }}>
            {title}
          </Text>
        )}
        {!!about && (
          <Tip lines={[about]}>
            <Icon name="info.circle" color={t.secondary} size={16} />
          </Tip>
        )}
      </View>
      {!!detail && <Text style={{ color: t.secondary, fontSize: 14 }}>{detail}</Text>}
      {checked && <Icon name="checkmark" color={t.accent} size={16} />}
      {chevron && <Icon name="chevron.right" color={t.secondary} size={14} />}
      {trailing}
    </Pressable>
  );
}

export function Header({ title, onBack }: { title: string; onBack?: () => void }) {
  const t = useTheme();
  const button: ViewStyle = {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  };
  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      {onBack ? (
        <TooltipButton accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} style={button}>
          <Icon name="chevron.left" color={t.accent} size={20} />
        </TooltipButton>
      ) : (
        <View style={button} />
      )}
      <Text
        accessibilityRole="header"
        numberOfLines={1}
        style={{
          flex: 1,
          textAlign: "center",
          color: t.text,
          fontSize: 17,
          fontWeight: "600",
        }}
      >
        {title}
      </Text>
      <TooltipButton accessibilityRole="button" accessibilityLabel="Close" onPress={() => router.back()} style={button}>
        <Icon name="xmark.circle.fill" color={t.secondary} size={26} />
      </TooltipButton>
    </View>
  );
}

export function Button({ title, onPress }: { title: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={{ minHeight: 44, alignItems: "center", justifyContent: "center" }}
    >
      <Text style={{ color: t.accent, fontSize: 15, fontWeight: "500" }}>{title}</Text>
    </Pressable>
  );
}
