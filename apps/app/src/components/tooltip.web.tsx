import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTheme } from "@/lib/theme";

/** Immediate web help in the top layer, so scroll containers cannot clip it. */
export function Tooltip({ text, children }: { text?: string; children: ReactNode }) {
  const t = useTheme();
  const id = useId();
  const anchor = useRef<HTMLDivElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const node = bubble.current;
    const target = anchor.current?.firstElementChild;
    if (!open || !text || !node || !target) return;
    node.showPopover();
    const rect = target.getBoundingClientRect();
    const size = node.getBoundingClientRect();
    node.style.left = `${Math.max(8, Math.min(rect.left + (rect.width - size.width) / 2, window.innerWidth - size.width - 8))}px`;
    node.style.top = `${Math.max(8, rect.bottom + size.height + 8 <= window.innerHeight - 8 ? rect.bottom + 8 : rect.top - size.height - 8)}px`;
    const previous = target.getAttribute("aria-describedby");
    target.setAttribute("aria-describedby", [previous, id].filter(Boolean).join(" "));
    const close = () => setOpen(false);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", keydown);
    return () => {
      node.hidePopover();
      if (previous === null) target.removeAttribute("aria-describedby");
      else target.setAttribute("aria-describedby", previous);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", keydown);
    };
  }, [open, text, id]);

  return (
    <div
      ref={anchor}
      style={{ display: "contents" }}
      onPointerEnter={(event) => event.pointerType !== "touch" && setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onPointerDown={() => setOpen(false)}
    >
      {children}
      {open && text && (
        <div
          ref={bubble}
          id={id}
          role="tooltip"
          popover="manual"
          style={{
            position: "fixed",
            inset: "auto",
            margin: 0,
            width: "max-content",
            maxWidth: "min(320px, calc(100vw - 16px))",
            boxSizing: "border-box",
            padding: "7px 10px",
            borderRadius: 8,
            border: `1px solid ${t.line}`,
            background: t.chip,
            color: t.text,
            fontSize: 12,
            lineHeight: "18px",
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
            overflowWrap: "anywhere",
            pointerEvents: "none",
            boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
          }}
        >
          {text}
        </div>
      )}
    </div>
  );
}
