import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import { SessionPRStatus } from "@mondash/shared/contract";
import { Gh } from "@/services/gh";
import { ReadOnly, Store, storeKey } from "@/services/store";
import { enabled } from "../profile";
import { sessionPRIdentities } from "./session-prs";
import type { AgentSession } from "./sessions";

const Response = Schema.Struct({
  data: Schema.Record(
    Schema.String,
    Schema.NullOr(
      Schema.Struct({
        pullRequest: Schema.NullOr(
          Schema.Struct({
            title: Schema.String,
            state: Schema.Literals(["OPEN", "MERGED", "CLOSED"]),
            isDraft: Schema.Boolean,
          }),
        ),
      }),
    ),
  ),
});

/** Lightweight status batches share the store's refresh/backoff; no per-row requests or CI hydration. */
export const sessionPRStatuses = Effect.fn("sessions.prStatuses")(function* (
  sessions: readonly AgentSession[],
): Effect.fn.Return<ReadonlyMap<string, SessionPRStatus>, never, Store | Gh> {
  if (!enabled("github")) return new Map();
  const identities = new Map(
    sessions.flatMap((session) =>
      sessionPRIdentities(session)
        .slice(0, 30)
        .map((pr) => [pr.key, pr] as const),
    ),
  );
  const ordered = [...identities.values()].sort((a, b) => a.key.localeCompare(b.key));
  const batches = Array.from({ length: Math.ceil(ordered.length / 25) }, (_, i) => ordered.slice(i * 25, i * 25 + 25));
  const store = yield* Store;
  const gh = yield* Gh;
  const readOnly = yield* ReadOnly;
  const results = yield* Effect.forEach(
    batches,
    (batch) => {
      const digest = createHash("sha256")
        .update(batch.map((pr) => pr.key).join("\n"))
        .digest("hex");
      const key = storeKey(`github:session-pr-statuses:${digest}:v1`, Schema.Array(SessionPRStatus));
      const fetch = Effect.gen(function* () {
        // Repositories and numbers came from the validated GitHub reference parser; string values are JSON quoted.
        const fields = batch.map((pr, i) => {
          const [owner, name] = pr.repo.split("/");
          return `p${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
          pullRequest(number: ${pr.number}) { title state isDraft }
        }`;
        });
        const response = yield* gh.json(
          ["api", "graphql", "-f", `query=query MondashSessionPRStatuses { ${fields.join("\n")} }`],
          Response,
          { allowMissingFields: true },
        );
        return batch.flatMap((identity, i): SessionPRStatus[] => {
          const pr = response.data[`p${i}`]?.pullRequest;
          return pr
            ? [{ url: identity.url, title: pr.title, state: pr.state === "OPEN" && pr.isDraft ? "DRAFT" : pr.state }]
            : [];
        });
      });
      // The desktop reads immediately; Dashboard.warm owns missing/stale provider lookups.
      return (
        readOnly
          ? store.read(key).pipe(Effect.map((stored) => stored?.value ?? []))
          : store.cached(key, "3 minutes", fetch)
      ).pipe(Effect.catch(() => Effect.succeed([])));
    },
    { concurrency: 2 },
  );
  return new Map(results.flat().map((pr) => [pr.url.toLowerCase(), pr]));
});
