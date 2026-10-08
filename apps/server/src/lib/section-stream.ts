import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import { type SectionName, SectionResponse } from "@mondash/shared/contract";

/** A section's version: its content, not `updatedAt` or `stale`, which a times-only event carries. */
const sectionVersion = (section: SectionResponse) =>
  createHash("sha1")
    .update(JSON.stringify([section.groups, section.threadsState, section.coverage]))
    .digest("hex")
    .slice(0, 16);

/** The versions the app already has, from `?have=issues:ab12,reviews:cd34`. */
export const parseHave = (have: string | null) =>
  new Map<string, string>(
    (have ? have.split(",") : []).flatMap((pair) => {
      const [name, version] = pair.split(":");
      return name && version ? [[name, version]] : [];
    }),
  );

/** What one connection has sent: each section's version, and its times. */
export type Sent = { readonly versions: Map<string, string>; readonly times: Map<string, string> };

/** A new connection, which already has the versions in `have`. */
export const sentFrom = (have: string | null): Sent => ({ versions: parseHave(have), times: new Map() });

/**
 * The server-sent event for a section, recorded in `sent`: all of it when its content changed, only its `updatedAt`
 * and `stale` when just those moved, else nothing. The section is encoded only when it is sent whole.
 */
export const sectionEvent = (sent: Sent, name: SectionName, section: SectionResponse) =>
  Effect.gen(function* () {
    const version = sectionVersion(section);
    const times = { section: name, updatedAt: section.updatedAt, stale: section.stale };
    const timesKey = JSON.stringify(times);
    if (sent.versions.get(name) !== version) {
      const encoded = yield* Schema.encodeEffect(SectionResponse)(section);
      sent.versions.set(name, version);
      sent.times.set(name, timesKey);
      return `data: ${JSON.stringify({ version, section: encoded })}\n\n`;
    }
    if (sent.times.get(name) === timesKey) return "";
    sent.times.set(name, timesKey);
    return `data: ${JSON.stringify({ times })}\n\n`;
  });
