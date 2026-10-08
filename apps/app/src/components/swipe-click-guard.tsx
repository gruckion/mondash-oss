import type { ReactNode } from "react";
import type { SharedValue } from "react-native-reanimated";

/** Native gesture recognition cancels child touches; web also needs to cancel the following click. */
export function SwipeClickGuard({ children }: { children: ReactNode; swiped: SharedValue<boolean> }) {
  return children;
}
