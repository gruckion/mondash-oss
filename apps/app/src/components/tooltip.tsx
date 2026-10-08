import type { ReactNode } from "react";

/** Native controls keep their existing touch behavior. */
export function Tooltip({ children }: { text?: string; children: ReactNode }) {
  return children;
}
