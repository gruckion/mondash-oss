import type { HoverTargetProps } from "./hover-target";

/** A non-interactive boundary: nested link/action controls keep their own clicks and keyboard focus. */
export function HoverTarget({ children, onHover, onFocus }: HoverTargetProps) {
  return (
    <div
      style={{ display: "flex", flexDirection: "column", minWidth: 0 }}
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") onHover(true);
      }}
      onPointerLeave={() => onHover(false)}
      onPointerCancel={() => onHover(false)}
      onFocus={() => onFocus(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onFocus(false);
      }}
    >
      {children}
    </div>
  );
}
