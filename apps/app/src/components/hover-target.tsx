import type { ReactNode } from "react";

export type HoverTargetProps = {
  children: ReactNode;
  onHover: (active: boolean) => void;
  onFocus: (active: boolean) => void;
};

/** Native touch has no hover scope and keeps the ordinary gestures/navigation. */
export function HoverTarget({ children }: HoverTargetProps) {
  return children;
}
