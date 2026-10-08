import { Option } from "effect";
import type { Connection } from "@mondash/shared/contract";
import { Integration, type Coverage } from "@mondash/shared/setup";
import { profile, identityDirectory, type Profile } from "./profile";
import type { Settings } from "./config";

export function coverage(
  connections: readonly Connection[],
  settings: Settings,
  selected: Profile = profile,
): Coverage[] {
  const self = identityDirectory(selected.directory).self;
  const configured = {
    github: !!self?.github,
    linear: Option.isSome(settings.linearApiKey),
    slack: !!self?.slack && Option.isSome(settings.slackClient),
    notion: !!selected.notion.view,
    sessions: true,
    classification: Option.isSome(settings.typesafe),
    notifications: Option.isSome(settings.ntfy.topic),
    tracing: Option.isSome(settings.otlpUrl),
  };
  return Integration.literals.map((name) => {
    const connection = connections.find((item) => item.name === name);
    const at = connection?.lastSyncedAt ?? connection?.checkedAt ?? null;
    // Providers with different search cadences own their expiry instead of sharing a fixed age cutoff.
    const due = connection?.refreshDueAt;
    const expires = due === undefined && at ? Date.parse(at) + 30 * 60_000 : due ? Date.parse(due) : NaN;
    const enabled = selected.integrations[name];
    const connected = enabled && configured[name] && connection?.state === "connected";
    const status: Coverage["status"] = !enabled
      ? "disabled"
      : !configured[name]
        ? "setup"
        : connection?.state === "error"
          ? "error"
          : connection?.state === "not-connected"
            ? "pending"
            : !at || !Number.isFinite(Date.parse(at)) || !Number.isFinite(expires)
              ? "unknown"
              : Date.now() > expires
                ? "stale"
                : "ready";
    const messages = {
      github: "Add your GitHub login, then run gh auth login on your Mac.",
      linear: "Set LINEAR_API_KEY in your Mac’s .env file.",
      slack:
        "Add your Slack member ID and your own approved app’s SLACK_CLIENT_ID and SLACK_CLIENT_SECRET, then sign in.",
      notion: "Choose a saved view and its columns, then sign in to Notion.",
      sessions: "Enable local session history when you want Claude/Codex links.",
      classification: "Set TYPESAFE_API_KEY and TYPESAFE_MODEL to opt in.",
      notifications: "Set NTFY_TOPIC to opt in.",
      tracing: "Set OTEL_EXPORTER_OTLP_ENDPOINT to opt in.",
    };
    return {
      name,
      enabled,
      configured: configured[name],
      connected,
      status,
      at,
      message:
        status === "disabled"
          ? "Disabled; saved data is retained."
          : status === "setup" || status === "pending"
            ? messages[name]
            : status === "error"
              ? (connection?.message ?? "Couldn’t refresh. Check the connection in Settings.")
              : status === "unknown"
                ? "Waiting for the first complete refresh."
                : status === "stale"
                  ? "Updates delayed. Mondash will retry automatically."
                  : "Ready",
    };
  });
}
