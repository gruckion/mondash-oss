import { Platform, useWindowDimensions } from "react-native";
import { usePathname } from "expo-router";
import type { ViewSection } from "@mondash/shared/view-options";

export const MOBILE_WIDTH = 768;

export function useHasBottomControls() {
  const { width } = useWindowDimensions();
  return Platform.OS === "web"
    ? width < MOBILE_WIDTH
    : Platform.OS === "ios" && Number.parseInt(String(Platform.Version), 10) >= 26;
}

/** Root screens use bottom controls; nested Inbox uses only its page tabs. Filter and Display live in the header menu. */
export function useBottomViewSection(): ViewSection | undefined {
  const path = usePathname();
  const supported = useHasBottomControls();
  if (!supported) return undefined;
  switch (path) {
    case "/issues/inbox":
    case "/scoping/inbox":
    case "/reviews/inbox":
    case "/sessions/inbox":
      return "inbox";
    case "/issues":
      return "issues";
    case "/scoping":
      return "scoping";
    case "/reviews":
      return "reviews";
    case "/sessions":
      return "sessions";
    default:
      return undefined;
  }
}
