import { useEffect } from "react";
import { router, useIsFocused } from "expo-router";
import { SessionsScreen } from "@/components/sessions-screen";
import { useDesktopPanel } from "@/lib/desktop-panel";

export default function Sessions() {
  const panel = useDesktopPanel();
  const focused = useIsFocused();
  const enabled = panel?.enabled;
  const setActive = panel?.setActive;
  useEffect(() => {
    if (!focused || !enabled || !setActive) return;
    setActive("sessions");
    router.navigate("/issues");
  }, [focused, enabled, setActive]);
  return enabled ? null : <SessionsScreen />;
}
