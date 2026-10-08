import { createContext } from "react";
import type { Session } from "@mondash/shared/contract";

/** The desktop conversation keeps its list mounted while the route parameters change. */
export const SessionSelectionContext = createContext<{
  tool: string;
  id: string;
  select: (session: Session) => void;
} | null>(null);
