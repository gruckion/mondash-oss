import { Alert, Linking, Platform, Pressable, Text, View, type ViewStyle } from "react-native";
import { createContext, useContext, type ReactNode } from "react";
import { useTheme } from "@/lib/theme";
import { openDesktopLink } from "@/lib/api";
import { isMacBrowser } from "@/lib/claude-target";
import { openExternalLink } from "@/lib/open-link";

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong. Please try again.";
/** A phone or tablet browser: links there should hand off to the GitHub, Slack or Linear app. */
export const touchWeb = () => Platform.OS === "web" && window.matchMedia("(pointer: coarse)").matches;

/**
 * Opens a link. On the web, a phone browser follows it in the same tab, so the app's universal link takes over with
 * no blank tab left behind; a desktop browser opens a new tab.
 */
export function openWebLink(url: string) {
  if (touchWeb()) window.location.assign(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

export async function openUrl(url: string) {
  try {
    await openExternalLink(url, {
      platform: Platform.OS,
      macDesktop: Platform.OS === "web" && isMacBrowser(navigator.userAgent, navigator.maxTouchPoints),
      openNative: (target) => Linking.openURL(target),
      openWeb: openWebLink,
      openDesktop: (target) => openDesktopLink(window.location.origin, target),
      // After awaiting the Mac, opening a new tab can be blocked. Same-tab fallback needs no popup permission.
      openFallback: (target) => window.location.assign(target),
    });
  } catch (error) {
    Alert.alert("Could not open link", errorMessage(error));
  }
}
/** DOM surfaces supply their native opener once for all nested card actions. */
export const OpenUrlContext = createContext(openUrl);
export const useOpenUrl = () => useContext(OpenUrlContext);

export function Button({
  title,
  onPress,
  disabled = false,
  subtle = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  subtle?: boolean;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        justifyContent: "center",
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 12,
        borderCurve: "continuous",
        backgroundColor: subtle ? t.tint : t.accent,
        opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
      })}
    >
      <Text
        style={{
          fontSize: 15,
          fontWeight: "600",
          color: subtle ? t.accent : t.card,
        }}
      >
        {title}
      </Text>
    </Pressable>
  );
}
export function Panel({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const t = useTheme();
  return (
    <View
      style={{
        backgroundColor: t.card,
        padding: 16,
        borderRadius: 18,
        borderCurve: "continuous",
        gap: 12,
        ...style,
      }}
    >
      {children}
    </View>
  );
}
export function Body({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  const t = useTheme();
  return (
    <Text
      selectable
      style={{
        color: muted ? t.secondary : t.text,
        fontSize: 15,
        lineHeight: 22,
      }}
    >
      {children}
    </Text>
  );
}
export function Heading({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <Text selectable accessibilityRole="header" style={{ color: t.text, fontSize: 19, fontWeight: "700" }}>
      {children}
    </Text>
  );
}
