function svg(body: string, size: number) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">${body}</svg>`;
}
function progress(color: string, fraction: number) {
  const angle = fraction * 2 * Math.PI;
  const x = (7 + 3.5 * Math.sin(angle)).toFixed(2);
  const y = (7 - 3.5 * Math.cos(angle)).toFixed(2);
  return `<circle cx="7" cy="7" r="6" fill="none" stroke="${color}" stroke-width="1.5"/><path d="M7,7 L7,3.5 A3.5,3.5 0 ${fraction > 0.5 ? 1 : 0} 1 ${x},${y} Z" fill="${color}"/>`;
}
function filled(color: string, path: string) {
  return `<circle cx="7" cy="7" r="7" fill="${color}"/><path d="${path}" fill="none" stroke="#1c1c1f" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;
}
const STATUS: Record<string, string> = {
  Backlog: '<circle cx="7" cy="7" r="6" fill="none" stroke="#bec2c8" stroke-width="1.5" stroke-dasharray="1.4 1.74"/>',
  Todo: '<circle cx="7" cy="7" r="6" fill="none" stroke="#e2e2e2" stroke-width="1.5"/>',
  "In Progress": progress("#f2c94c", 0.25),
  Testing: progress("#5fc592", 0.5),
  "In Review": progress("#4cb34f", 0.75),
  Done: filled("#5e6ad2", "M4.2,7.2 L6.1,9 L9.8,5.2"),
  Canceled: filled("#95a2b3", "M5,5 L9,9 M9,5 L5,9"),
  Duplicate: filled("#95a2b3", "M4.6,7.6 L7.6,4.6 M6.4,9.4 L9.4,6.4"),
  Triage: filled("#fc7840", "M3.8,7 L10.2,7 M5.6,5.2 L3.8,7 L5.6,8.8 M8.4,5.2 L10.2,7 L8.4,8.8"),
};
STATUS["Not Ready"] = STATUS.Backlog;
const BY_TYPE: Record<string, string> = {
  backlog: "Backlog",
  unstarted: "Todo",
  started: "In Progress",
  completed: "Done",
  canceled: "Canceled",
  duplicate: "Duplicate",
  triage: "Triage",
};
export function linearStatusIcon(status: string, statusType?: string) {
  const body = STATUS[status] ?? (statusType ? STATUS[BY_TYPE[statusType]] : undefined) ?? STATUS.Todo;
  return svg(body, 14);
}
const PRIORITY_BARS: Record<number, number> = { 2: 3, 3: 2, 4: 1 };
export function linearPriorityIcon({
  priority,
  color,
}: {
  priority: { value: number; name: string };
  /** Bar colour; Linear's grey when absent. */
  color?: string;
}) {
  const filled = PRIORITY_BARS[priority.value];
  const body =
    priority.value === 1
      ? '<rect x="1" y="1" width="14" height="14" rx="3" fill="#fc7840"/><path d="M8 4v5" stroke="white" stroke-width="2" stroke-linecap="round"/><circle cx="8" cy="11.8" r="1.1" fill="white"/>'
      : [0, 1, 2]
          .map((i) =>
            filled
              ? `<rect x="${1.5 + i * 5}" y="${10 - i * 3.5}" width="3" height="${4.5 + i * 3.5}" rx="1" fill="${color && i < filled ? color : (color ?? "#929298")}" opacity="${i < filled ? 0.9 : 0.3}"/>`
              : `<rect x="${1.5 + i * 5}" y="7.25" width="3" height="1.5" rx=".75" fill="${color ?? "#929298"}" opacity=".6"/>`,
          )
          .join("");
  return svg(body, 16);
}
