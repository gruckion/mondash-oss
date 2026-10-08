import { Image } from "expo-image";
import { Platform } from "react-native";
import { SvgIcon } from "./web-icons";

// Web has no SF Symbols, so each one the app uses is redrawn from Lucide (ISC) in the same stroke style.
const WEB: Record<string, (color: string) => string> = {
  clock: () => `<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>`,
  archivebox: () => `<rect x="3" y="3" width="18" height="4" rx="1"/><path d="M5 7v14h14V7M10 11h4"/>`,
  "arrow.uturn.backward": () => `<path d="m9 10-5-5 5-5M4 5h9a6 6 0 0 1 0 12h-1"/>`,
  magnifyingglass: () => `<circle cx="10.5" cy="10.5" r="7.5"/><path d="m16 16 5 5"/>`,
  "chevron.down": () => `<path d="m6 9 6 6 6-6"/>`,
  "chevron.right": () => `<path d="m9 18 6-6-6-6"/>`,
  "chevron.left": () => `<path d="m15 18-6-6 6-6"/>`,
  terminal: () => `<path d="m4 17 6-6-6-6M12 19h8"/>`,
  "xmark.circle.fill": (c) =>
    `<circle cx="12" cy="12" r="10" fill="${c}" stroke="none"/><path d="m15 9-6 6M9 9l6 6" stroke="#fff"/>`,
  "envelope.open": () =>
    `<path d="M21.2 8.4c.5.38.8.97.8 1.6v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 .8-1.6l8-6a2 2 0 0 1 2.4 0l8 6Z"/><path d="m22 10-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 10"/>`,
  "envelope.badge": (c) =>
    `<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/><circle cx="20" cy="5" r="3" fill="${c}"/>`,
  link: () =>
    `<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>`,
  "exclamationmark.circle": () => `<circle cx="12" cy="12" r="10"/><path d="M12 7v6M12 17h.01"/>`,
  "arrow.clockwise": () => `<path d="M20 11a8 8 0 1 0-2.4 6M20 4v7h-7"/>`,
  "info.circle": () => `<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>`,
  checkmark: () => `<path d="M20 6 9 17l-5-5"/>`,
  xmark: () => `<path d="M18 6 6 18M6 6l12 12"/>`,
  plus: () => `<path d="M5 12h14M12 5v14"/>`,
  ellipsis: (c) =>
    `<circle cx="5" cy="12" r="1" fill="${c}"/><circle cx="12" cy="12" r="1" fill="${c}"/><circle cx="19" cy="12" r="1" fill="${c}"/>`,
  gearshape: () =>
    `<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>`,
  "arrow.triangle.merge": () =>
    `<circle cx="6" cy="5" r="3"/><path d="M6 8v13M18 6c0 7-12 2-12 9"/><path d="m15 9 3-3 3 3"/>`,
  "arrow.up.right": () => `<path d="M7 7h10v10M7 17 17 7"/>`,
  tray: () =>
    `<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>`,
  "doc.text": () =>
    `<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8"/>`,
  "checkmark.circle": () => `<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>`,
  "line.3.horizontal.decrease": () => `<path d="M3 6h18M7 12h10M10 18h4"/>`,
  "switch.2": () =>
    `<path d="M3 8h8M17 8h4M3 16h4M13 16h8"/><circle cx="14" cy="8" r="3"/><circle cx="10" cy="16" r="3"/>`,
  "arrow.up.arrow.down": () => `<path d="m3 16 4 4 4-4M7 20V4M21 8l-4-4-4 4M17 4v16"/>`,
  "dot.viewfinder": (c) =>
    `<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="2" fill="${c}"/>`,
  "square.stack.3d.up": () =>
    `<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65M22 12.65l-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>`,
  "text.bubble": () =>
    `<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M13 8H7M17 12H7"/>`,
};

export type IconName = keyof typeof WEB;

/** An SF Symbol on iOS; its Lucide twin on the web. */
export function Icon({
  name,
  color,
  size = 16,
  label,
}: {
  name: IconName;
  color: string;
  size?: number;
  label?: string;
}) {
  if (name === "review.branch")
    return (
      <Image
        source={require("../../assets/reviews-branch.png")}
        tintColor={color}
        contentFit="contain"
        accessible={!!label}
        accessibilityLabel={label}
        style={{ width: size, height: size, flexShrink: 0 }}
      />
    );
  if (Platform.OS !== "web")
    return (
      <Image
        source={`sf:${name}`}
        tintColor={color}
        contentFit="contain"
        accessible={!!label}
        accessibilityLabel={label}
        style={{ width: size, height: size, flexShrink: 0 }}
      />
    );
  return (
    <SvgIcon
      svg={`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${WEB[name](color)}</svg>`}
      label={label}
      size={size}
    />
  );
}
