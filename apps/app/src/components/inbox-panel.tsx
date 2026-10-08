import { useEffect } from "react";
import { router, useIsFocused, type Href } from "expo-router";
import { useDesktopPanel } from "@/lib/desktop-panel";
import { InboxScreen } from "./inbox-screen";

/** Desktop deep links and a resized phone Inbox become a blade alongside the originating screen. */
export function InboxRoute({ tab }: { tab: string }) {
  const panel = useDesktopPanel();
  const focused = useIsFocused();
  const enabled = panel?.enabled;
  const setActive = panel?.setActive;
  useEffect(() => {
    if (!focused || !enabled || !setActive) return;
    setActive("inbox");
    if (tab === "sessions") router.navigate("/issues");
    else router.dismissTo(`/${tab}` as Href);
  }, [focused, enabled, setActive, tab]);
  return panel?.enabled ? null : <InboxScreen />;
}
