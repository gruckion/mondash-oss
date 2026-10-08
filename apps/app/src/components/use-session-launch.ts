import type { Session } from "@mondash/shared/contract";
import { openRemoteSession, openSessionOnMac } from "@/lib/api";
import { useSettings } from "@/lib/provider";
import { useLaunch } from "./use-launch";

/** The Open button and card swipe share the same provider, Mac preference and remote handoff. */
export function useSessionLaunch(session: Session) {
  const { server, macDesktop, claudeTarget } = useSettings();
  const claude = session.tool === "claude";
  const local = claude && macDesktop;
  const appName = claude ? (local && claudeTarget === "terminal" ? "Terminal" : "Claude") : "ChatGPT";
  const canOpen = local || (claude ? (session.canOpenInClaude ?? true) : (session.canOpenInChatGPT ?? true));
  const launch = useLaunch(
    `Could not open in ${appName}`,
    () =>
      local ? openSessionOnMac(server, session.id, claudeTarget) : openRemoteSession(server, session.id, session.tool),
    undefined,
    undefined,
    false,
    { local },
  );
  return { ...launch, appName, canOpen };
}
