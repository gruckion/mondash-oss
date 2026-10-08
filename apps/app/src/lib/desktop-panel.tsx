import { createContext, use, useState, type ReactNode } from "react";

type Panel = "inbox" | "sessions";

// Provided by the web tabs layout only; native navigation keeps its dedicated screens.
const DesktopPanelContext = createContext<{
  enabled: boolean;
  active: Panel | null;
  setActive: (panel: Panel | null) => void;
} | null>(null);

export function DesktopPanelProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [active, setActive] = useState<Panel | null>(null);
  return <DesktopPanelContext value={{ enabled, active, setActive }}>{children}</DesktopPanelContext>;
}

export const useDesktopPanel = () => use(DesktopPanelContext);
