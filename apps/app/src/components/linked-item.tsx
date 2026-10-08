import { createContext, use, useEffect, useId, type ReactNode } from "react";
import { View } from "react-native";
import { inItemScope, type ItemScope } from "@mondash/shared/linked-items";
import { ContainingItem, useLinkHighlights } from "@/lib/link-highlights";
import { useTheme } from "@/lib/theme";
import { HoverTarget } from "./hover-target";

// A containing card/stack already shows the association; nested rows keep their hover scope without another outline.
const EnclosingHighlight = createContext(false);

/** Insets are permanent, so the outline never touches content and hovering never shifts the layout. */
export function HighlightBox({
  children,
  highlighted,
  bleed = false,
  padding = 8,
  gap = 6,
}: {
  children: ReactNode;
  highlighted: boolean;
  bleed?: boolean;
  /** Groups whose children already have padding do not need a second inset. */
  padding?: number;
  gap?: number;
}) {
  const t = useTheme();
  const enclosingHighlight = use(EnclosingHighlight);
  const visible = highlighted && !enclosingHighlight;
  return (
    <View
      style={{
        padding,
        gap,
        marginHorizontal: bleed ? -8 : 0,
        borderRadius: 12,
        backgroundColor: visible ? (t.dark ? "#8b5cf629" : "#8b5cf61a") : undefined,
      }}
    >
      <EnclosingHighlight value={enclosingHighlight || highlighted}>{children}</EnclosingHighlight>
      {visible && (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            inset: 0,
            borderWidth: 2,
            borderColor: t.dark ? "#a78bfa" : "#7c3aed",
            borderRadius: 12,
            zIndex: 2,
          }}
        />
      )}
    </View>
  );
}

export function LinkedItem({
  item,
  children,
  bleed = false,
  outlined = true,
}: {
  item: ItemScope;
  children: ReactNode;
  bleed?: boolean;
  /** A shared outline can surround several ticket items while each remains an independent hover source. */
  outlined?: boolean;
}) {
  const state = useLinkHighlights();
  const parent = use(ContainingItem);
  const token = useId();
  const depth = (parent?.depth ?? 0) + 1;
  const leave = state?.leave;
  useEffect(() => () => leave?.(token), [leave, token]);
  if (!state) return children;
  return (
    <ContainingItem value={{ depth, item }}>
      <HoverTarget
        onHover={(active) => (active ? state.enter({ token, depth, item }, "hover") : state.leave(token, "hover"))}
        onFocus={(active) => (active ? state.enter({ token, depth, item }, "focus") : state.leave(token, "focus"))}
      >
        <HighlightBox highlighted={outlined && inItemScope(state.active, item)} bleed={bleed}>
          {children}
        </HighlightBox>
      </HoverTarget>
    </ContainingItem>
  );
}
