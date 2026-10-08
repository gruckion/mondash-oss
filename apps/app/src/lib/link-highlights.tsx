import { createContext, use, useCallback, useMemo, useState, type ReactNode } from "react";
import { inItemScope, type ItemScope } from "@mondash/shared/linked-items";

type Target = { token: string; depth: number; item: ItemScope };
const Context = createContext<{
  active: ItemScope | null;
  enter: (target: Target, kind: "hover" | "focus") => void;
  leave: (token: string, kind?: "hover" | "focus") => void;
} | null>(null);
export const ContainingItem = createContext<{ depth: number; item: ItemScope } | null>(null);

/** Nested rows take precedence over their containing card. Leaving a row restores the containing card's scope. */
export function LinkHighlightsProvider({ children }: { children: ReactNode }) {
  const [hovered, setHovered] = useState<readonly Target[]>([]);
  const [focused, setFocused] = useState<readonly Target[]>([]);
  const enter = useCallback((target: Target, kind: "hover" | "focus") => {
    const set = kind === "hover" ? setHovered : setFocused;
    set((current) => [...current.filter((entry) => entry.token !== target.token), target]);
  }, []);
  const leave = useCallback((token: string, kind?: "hover" | "focus") => {
    const remove = (current: readonly Target[]) => {
      const next = current.filter((entry) => entry.token !== token);
      return next.length === current.length ? current : next;
    };
    if (kind !== "focus") setHovered(remove);
    if (kind !== "hover") setFocused(remove);
  }, []);
  const deepest = (targets: readonly Target[]) =>
    targets.reduce<Target | null>((best, target) => (!best || target.depth >= best.depth ? target : best), null)
      ?.item ?? null;
  const active = deepest(hovered) ?? deepest(focused);
  const value = useMemo(() => ({ active, enter, leave }), [active, enter, leave]);
  return <Context value={value}>{children}</Context>;
}

export const useLinkHighlights = () => use(Context);
export function useAllHighlighted(items: readonly ItemScope[]) {
  const state = use(Context);
  return items.length > 0 && items.every((item) => inItemScope(state?.active ?? null, item));
}
