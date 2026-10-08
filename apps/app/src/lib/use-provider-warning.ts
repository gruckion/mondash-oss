import { useConnection, useProviderHealth } from "./provider";
import { needsAttention, providerProblems, PROVIDER_NAMES } from "./provider-health";

/** The header and every Settings menu show the same connection warning. */
export function useProviderWarning() {
  const health = useProviderHealth();
  const connection = useConnection();
  const failed = (health.data?.connections ?? []).some(needsAttention);
  const names = providerProblems(health.data?.connections ?? []).map((provider) => PROVIDER_NAMES[provider.name]);
  return connection === "down"
    ? "Mac connection lost — showing saved data"
    : health.isError
      ? "Could not check provider connections"
      : failed
        ? `${names.length ? names.join(", ") : "Connections"} need attention`
        : undefined;
}
