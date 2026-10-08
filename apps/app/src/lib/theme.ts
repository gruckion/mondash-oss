import { useColorScheme } from "react-native";
import { createContext, use } from "react";
export const ThemeSurface = createContext<"app" | "session" | "session-sidebar">("app");
export function useTheme() {
  const dark = useColorScheme() === "dark";
  const surface = use(ThemeSurface);
  const background = dark
    ? surface === "session-sidebar"
      ? "#1e1e1e"
      : surface === "session"
        ? "#181818"
        : "#0a0a0a"
    : "#ffffff";
  return {
    dark,
    background,
    card: background,
    sessionSidebar: dark ? "#1e1e1e" : "#ffffff",
    text: dark ? "#ededed" : "#171717",
    secondary: dark ? "#a1a1aa" : "#71717a",
    accent: dark ? "#93b5ff" : "#245be0",
    line: dark ? (surface === "app" ? "#27272a" : "#303030") : "#e4e4e7",
    chip: dark ? (surface === "app" ? "#27272a" : "#303030") : "#f4f4f5",
    labelBorder: dark ? "#3f3f46" : "#d4d4d8",
    tint: dark ? "#223453" : "#edf2ff",
    warning: dark ? "#f8c884" : "#986019",
  };
}
export function ago(value: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
  return minutes < 1
    ? "just now"
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : `${Math.floor(minutes / 1440)}d ago`;
}
