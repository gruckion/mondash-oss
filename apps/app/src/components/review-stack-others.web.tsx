import type { ReactNode } from "react";
import { useTheme } from "@/lib/theme";

/** Native details keeps folded PRs in the document so browser Find can reveal them. */
export function ReviewStackOthers({ count, children }: { count: number; children: ReactNode }) {
  const t = useTheme();
  return (
    <details
      style={{
        color: t.secondary,
        fontSize: 13,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      }}
    >
      <summary style={{ cursor: "pointer", padding: 12, minHeight: 20 }}>
        {count} other PR{count === 1 ? "" : "s"}
      </summary>
      {children}
    </details>
  );
}
