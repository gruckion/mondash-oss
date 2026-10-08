import { useEffect, type ReactNode } from "react";
import { Platform, Pressable, useWindowDimensions, View } from "react-native";
import { router, type NativeStackNavigationOptions } from "expo-router";
import { useTheme } from "@/lib/theme";

/** At this width a sheet becomes a centred modal, as in the Ecosave web app. */
const MODAL = 768;

/**
 * A route shown as a sheet. iOS draws the form sheet itself, so this passes straight through; the web draws a bottom
 * sheet on a phone-sized screen and a centred modal on a wider one. The backdrop and Escape close it.
 */
export function Sheet({ children }: { children: ReactNode }) {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const web = Platform.OS === "web";
  useEffect(() => {
    if (!web) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") router.back();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [web]);
  if (!web) return children;
  const modal = width >= MODAL;
  return (
    <View
      style={{
        flex: 1,
        justifyContent: modal ? "center" : "flex-end",
        alignItems: "center",
        padding: modal ? 24 : 0,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        onPress={() => router.back()}
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
          backgroundColor: "rgba(0,0,0,0.4)",
        }}
      />
      <View
        accessibilityViewIsModal
        style={{
          width: "100%",
          maxWidth: modal ? 560 : undefined,
          maxHeight: modal ? "85%" : "88%",
          backgroundColor: t.background,
          borderRadius: 16,
          borderBottomLeftRadius: modal ? 16 : 0,
          borderBottomRightRadius: modal ? 16 : 0,
          overflow: "hidden",
          borderWidth: 1,
          borderColor: t.line,
          boxShadow: "0 24px 80px rgba(0,0,0,0.32)",
        }}
      >
        {!modal && (
          <View
            style={{
              alignSelf: "center",
              width: 36,
              height: 5,
              borderRadius: 3,
              marginTop: 6,
              backgroundColor: t.line,
            }}
          />
        )}
        {children}
      </View>
    </View>
  );
}

/** Screen options for a sheet route: the iOS form sheet, or a transparent route the web draws a Sheet in. */
export const sheetOptions: NativeStackNavigationOptions =
  Platform.OS === "web"
    ? {
        presentation: "transparentModal",
        headerShown: false,
        animation: "fade",
        contentStyle: { backgroundColor: "transparent" },
      }
    : {
        presentation: "formSheet",
        headerShown: false,
        sheetGrabberVisible: true,
        sheetAllowedDetents: [0.5, 1],
        sheetInitialDetentIndex: 0,
        contentStyle: { backgroundColor: "transparent" },
      };
