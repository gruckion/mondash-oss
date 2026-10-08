// Notion Roadmap statuses drawn in Linear's style, as SVG strings the web and the iPhone share. No React.

type NotionColor = "gray" | "brown" | "orange" | "yellow" | "green" | "blue" | "purple" | "pink" | "red" | "white";
type Shape = "dashed" | "empty" | "pie" | "pause" | "done" | "cancelled";

// ponytail: the Roadmap's Status options, copied by hand (2026-09-25). No Notion doc defines them, so the shapes
// follow the process page: the pie fills along scoping, parked and blocked cards get their own shape. Design's
// place in the flow is a guess. Read the data source schema instead if the options change often.
const STATUS: Record<string, { color: NotionColor; shape: Shape; fill?: number }> = {
  Deprioritised: { color: "brown", shape: "dashed" },
  "Bets (to be prioritized)": { color: "purple", shape: "dashed" },
  "Prioritized Backlog (Feature Parity)": { color: "gray", shape: "dashed" },
  Backlog: { color: "gray", shape: "dashed" },
  "Ready - Deprioritized": { color: "blue", shape: "empty" },
  Scoping: { color: "yellow", shape: "pie", fill: 0.25 },
  "Scoping - Ready to review": { color: "pink", shape: "pie", fill: 0.5 },
  Reviewed: { color: "blue", shape: "pie", fill: 0.75 },
  Design: { color: "purple", shape: "pie", fill: 0.75 },
  Blocked: { color: "orange", shape: "pause" },
  Todo: { color: "white", shape: "empty" },
  "In progress": { color: "blue", shape: "pie", fill: 0.5 },
  Cancelled: { color: "red", shape: "cancelled" },
  Shipped: { color: "green", shape: "done" },
};

// Notion's dot colours: sampled from its iOS app in dark mode, its light palette otherwise.
const DARK: Record<NotionColor, string> = {
  gray: "#8e8b86",
  brown: "#b68965",
  orange: "#d5803b",
  yellow: "#d8a32f",
  green: "#46a171",
  blue: "#2783de",
  purple: "#b577d6",
  pink: "#db6999",
  red: "#e56458",
  white: "#e2e2e2",
};
const LIGHT: Record<NotionColor, string> = {
  gray: "#91918e",
  brown: "#9f6b53",
  orange: "#d9730d",
  yellow: "#cb912f",
  green: "#448361",
  blue: "#337ea9",
  purple: "#9065b0",
  pink: "#c14c8a",
  red: "#d44c47",
  white: "#9b9a97",
};

const ring = (c: string, extra = "") =>
  `<circle cx="7" cy="7" r="6" fill="none" stroke="${c}" stroke-width="1.5"${extra}/>`;

function icon(shape: Shape, c: string, fill = 0) {
  if (shape === "dashed") return ring(c, ' stroke-dasharray="1.4 1.74"');
  if (shape === "empty") return ring(c);
  if (shape === "pause")
    return `${ring(c)}<path d="M5.5 4.8v4.4M8.5 4.8v4.4" stroke="${c}" stroke-width="1.5" stroke-linecap="round"/>`;
  if (shape === "done")
    return `<circle cx="7" cy="7" r="7" fill="${c}"/><path d="M4.3 7.2l1.9 1.9 3.6-4" fill="none" stroke="#1c1c1f" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;
  if (shape === "cancelled")
    return `<circle cx="7" cy="7" r="7" fill="${c}"/><path d="M4.8 4.8l4.4 4.4M9.2 4.8l-4.4 4.4" fill="none" stroke="#1c1c1f" stroke-width="1.6" stroke-linecap="round"/>`;
  const angle = fill * 2 * Math.PI;
  const x = (7 + 3.5 * Math.sin(angle)).toFixed(2);
  const y = (7 - 3.5 * Math.cos(angle)).toFixed(2);
  return `${ring(c)}<path d="M7,7 L7,3.5 A3.5,3.5 0 ${fill > 0.5 ? 1 : 0} 1 ${x},${y} Z" fill="${c}"/>`;
}

/** The status icon as a 14px SVG: Linear's shape for where the card is, in Notion's colour for the status. */
export function notionStatusSvg(status: string, dark: boolean): string {
  const known = STATUS[status];
  const color = (dark ? DARK : LIGHT)[known ? known.color : "gray"];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14">${icon(known ? known.shape : "empty", color, known?.fill)}</svg>`;
}

/** Notion's colour for a Roadmap Priority option; Medium is Notion's default, so it keeps Linear's grey. */
export function notionPriorityColor(priority: string, dark: boolean) {
  const color: NotionColor | undefined = priority === "High" ? "purple" : priority === "Low" ? "brown" : undefined;
  return color ? (dark ? DARK : LIGHT)[color] : undefined;
}
