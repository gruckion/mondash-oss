import { Effect, Schema } from "effect";
import type { NotionSetupCheck } from "@mondash/shared/setup";
import { enabled, profile, type Profile } from "./profile";
import { Mcp, McpFailure } from "./services/mcp";

export function inspectNotionRows(
  results: readonly unknown[],
  hasMore: boolean,
  mapping: Profile["notion"],
): NotionSetupCheck {
  const rows = results.filter(
    (row): row is Record<string, unknown> => typeof row === "object" && row !== null && !Array.isArray(row),
  );
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]
    .filter((key) => !["id", "url"].includes(key))
    .sort();
  const missing = Object.entries(mapping.properties).flatMap(([key, column]) =>
    column !== null && rows.some((row) => !(column in row)) ? [`${key}: ${column}`] : [],
  );
  const statuses = [
    ...new Set(
      rows.flatMap((row) =>
        typeof row[mapping.properties.status] === "string" ? [String(row[mapping.properties.status])] : [],
      ),
    ),
  ].sort();
  return { columns, missing, statuses, rows: rows.length, truncated: hasMore || results.length >= 100 };
}
const Answer = Schema.fromJsonString(
  Schema.Struct({ results: Schema.Array(Schema.Unknown), has_more: Schema.optional(Schema.Boolean) }),
);
export const checkNotionSetup = (mcp: Mcp["Service"]) =>
  Effect.gen(function* () {
    if (!enabled("notion"))
      return yield* new McpFailure({ server: "notion", cause: "Notion is disabled or has no selected view" });
    const decoded = yield* Schema.decodeUnknownEffect(Answer)(
      yield* mcp.call("notion", "notion-query-data-sources", {
        data: { mode: "view", view_url: profile.notion.view, page_size: 100 },
      }),
    );
    return inspectNotionRows(decoded.results, decoded.has_more === true, profile.notion);
  });
