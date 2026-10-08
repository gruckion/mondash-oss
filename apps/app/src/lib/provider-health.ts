import type { Connection } from "@mondash/shared/contract";

export const PROVIDER_NAMES = {
  linear: "Linear",
  slack: "Slack",
  notion: "Notion",
  github: "GitHub",
  claude: "Claude Code",
  codex: "Codex",
};
export type ProviderName = keyof typeof PROVIDER_NAMES;
export type ProviderProblem = Connection & { name: ProviderName };

export const needsAttention = (connection: Connection) =>
  connection.state === "error" || connection.state === "not-connected";

/** Healthy and not-yet-checked sources stay out of the header. */
export const providerProblems = (connections: readonly Connection[]): ProviderProblem[] =>
  connections.flatMap((connection) =>
    Object.hasOwn(PROVIDER_NAMES, connection.name) && needsAttention(connection)
      ? [{ ...connection, name: connection.name as ProviderName }]
      : [],
  );

export const problemTitle = (connection: ProviderProblem) =>
  connection.message ??
  `${PROVIDER_NAMES[connection.name]} ${connection.state === "not-connected" ? "disconnected" : "refresh failed"}`;
