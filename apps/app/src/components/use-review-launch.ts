import { openSessionOnMac, startClaudeReview } from "@/lib/api";
import { useSettings } from "@/lib/provider";
import { useLaunch } from "./use-launch";

/** A button or swipe starts the usual review directly, or reopens the server's existing review. */
export function useReviewLaunch(url: string, onStarted: () => void, startNew = false) {
  const { server, macDesktop, claudeTarget, refreshSection } = useSettings();
  const appName = macDesktop && claudeTarget === "terminal" ? "Terminal" : "Claude";
  const launch = useLaunch(
    "Could not start review",
    async () => {
      const review = await startClaudeReview(server, url, startNew);
      if (macDesktop) return openSessionOnMac(server, review.sessionId, claudeTarget);
      return review;
    },
    onStarted,
    () => refreshSection("sessions"),
    true,
    { local: macDesktop, immediate: true },
  );
  return { ...launch, appName, canOpen: true };
}
