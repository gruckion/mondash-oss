import type { ReactNode, SyntheticEvent } from "react";
import type { SharedValue } from "react-native-reanimated";

/** Keep suppression through pointer release and reset only for the next deliberate interaction. */
export function SwipeClickGuard({ children, swiped }: { children: ReactNode; swiped: SharedValue<boolean> }) {
  const reset = () => swiped.set(false);
  const suppress = (event: SyntheticEvent) => {
    if (!swiped.get()) return;
    event.preventDefault();
    event.stopPropagation();
  };
  return (
    <div
      style={{ display: "contents" }}
      onPointerDownCapture={reset}
      onKeyDownCapture={reset}
      onClickCapture={suppress}
      onContextMenuCapture={suppress}
    >
      {children}
    </div>
  );
}
