import { Schema } from "effect";
import { profile, identityDirectory } from "../profile";

export type Person = { name: string; email: string; slack: string; github?: string };

export const PEOPLE: Person[] = profile.directory.people.map(({ name, email, slack, github }) => ({
  name,
  email: email ?? "",
  slack: slack ?? "",
  ...(github ? { github } : {}),
}));
const directory = identityDirectory(profile.directory);
export const ME = profile.directory.me;
export const selfName = directory.self?.name ?? "you";
export const selfFirstName = selfName.split(/\s+/)[0];
export const isMe = (key: string) => !!directory.self && directory.person(key) === directory.self;

/** Explicit identifiers and aliases win; ambiguous display names remain unresolved. */
export function person(key: string): Person | undefined {
  const found = directory.person(key);
  const index = found ? profile.directory.people.indexOf(found) : -1;
  return index >= 0 ? PEOPLE[index] : undefined;
}

/** "Morgan P": first name and the initial of the last, like Slack. Unknown keys show as they are. */
export function displayName(key: string): string {
  const p = person(key);
  if (!p) return key.includes("@") ? key.slice(0, key.indexOf("@")) : key;
  const parts = p.name.split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}` : parts[0];
}

/**
 * Replies waiting for you on a PR or a Notion doc: open threads where someone else has the last word.
 * `from` holds GitHub logins or emails, newest first, one per person.
 */
export const Reply = Schema.Struct({
  from: Schema.Array(Schema.String),
  count: Schema.Finite,
  at: Schema.Date,
  url: Schema.String,
});
export type Reply = typeof Reply.Type;

/** One Reply from the waiting comments, or null if none. */
export function toReply(waiting: { from: string; at: Date; url: string }[]): Reply | null {
  const sorted = waiting.toSorted((a, b) => b.at.getTime() - a.at.getTime());
  const [newest] = sorted;
  if (!newest) return null;
  return { from: [...new Set(sorted.map((w) => w.from))], count: sorted.length, at: newest.at, url: newest.url };
}
