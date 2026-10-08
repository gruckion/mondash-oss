import type { Href } from "expo-router";
import type { ViewSection } from "@mondash/shared/view-options";
import type { IconName } from "./icon";

/** Each screen's options open directly; the menu never combines Filter and Display into another picker. */
export function moreMenuItems(section: ViewSection) {
  return [
    {
      id: "filter",
      title: "Filter",
      icon: "line.3.horizontal.decrease",
      href: { pathname: "/view-options", params: { section, panel: "filter" } },
    },
    {
      id: "display",
      title: "Display",
      icon: "switch.2",
      href: { pathname: "/view-options", params: { section, panel: "display" } },
    },
    { id: "debrief", title: "Debriefs", icon: "doc.text", href: "/debrief" },
    { id: "settings", title: "Settings", icon: "gearshape", href: "/settings" },
  ] as const satisfies readonly { id: string; title: string; icon: IconName; href: Href }[];
}
