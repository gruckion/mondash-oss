import { notionProperties } from "../profile";
import { Schema, Effect } from "effect";
import type { Group, Person, Row } from "@mondash/shared/contract";
import { displayName, isMe } from "./people.ts";

const Users = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.optional(Schema.String),
      email: Schema.optional(Schema.String),
      avatar_url: Schema.optional(Schema.String),
    }),
  ),
});
const Page = Schema.Struct({ text: Schema.String, page_last_edited_at: Schema.optional(Schema.String) });
const Properties = Schema.Struct({
  Assign: Schema.optional(Schema.Array(Schema.String)),
  Reviewer: Schema.optional(Schema.Array(Schema.String)),
  Effort: Schema.optional(Schema.Union([Schema.String, Schema.Finite])),
  "Effort (Days)": Schema.optional(Schema.Finite),
  Created: Schema.optional(Schema.String),
  "Last edited time": Schema.optional(Schema.String),
});
const decodeUsers = Schema.decodeUnknownSync(Users);
const decodePage = Schema.decodeUnknownSync(Page);
const decodeProperties = Schema.decodeUnknownSync(Properties);
type NotionMetadata = Pick<Row, "assignees" | "reviewers" | "effort" | "createdAt" | "updatedAt">;

export function notionPeople(payload: unknown): Map<string, Person> {
  return new Map(
    decodeUsers(payload).results.flatMap((user): [string, Person][] => {
      const key = user.email || user.name;
      if (!key || isMe(key)) return [];
      const avatar = user.avatar_url && /^https:\/\//.test(user.avatar_url) ? user.avatar_url : undefined;
      return [[user.id, { name: displayName(key), ...(avatar ? { avatar } : {}) }]];
    }),
  );
}

const timestamp = (value: string | undefined): string | undefined => {
  if (!value || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
};

/** Notion's fetch response wraps the page properties as JSON inside its text representation. */
export function notionRowMetadata(payload: unknown, users: Map<string, Person>): NotionMetadata {
  const page = decodePage(payload);
  const text = page.text.match(/<properties>\s*([\s\S]*?)\s*<\/properties>/)?.[1];
  const properties = decodeProperties(notionProperties(text ? JSON.parse(text) : {}));
  const people = (values: readonly string[] | undefined): Person[] =>
    (values ?? []).flatMap((value) => {
      const id = value.match(/user:\/\/([\w-]+)/)?.[1];
      const person = id ? users.get(id) : undefined;
      return person ? [{ ...person }] : [];
    });
  const days = properties["Effort (Days)"];
  const effort =
    days !== undefined ? `${days}d` : properties.Effort === undefined ? "" : String(properties.Effort).trim();
  return {
    assignees: people(properties.Assign),
    reviewers: people(properties.Reviewer),
    ...(effort ? { effort } : {}),
    createdAt: timestamp(properties.Created),
    updatedAt: timestamp(properties["Last edited time"] ?? page.page_last_edited_at),
  };
}

/** The same Notion project can appear on many tickets. Resolve it once, keeping links on failure. */
export const enrichNotionRows = <E, R>(
  groups: ReadonlyArray<Group>,
  lookup: (id: string) => Effect.Effect<NotionMetadata, E, R>,
): Effect.Effect<Group[], never, R> => {
  const rows = groups
    .flatMap((group) => group.cards.flatMap((card) => card.rows ?? []))
    .filter((row) => row.kind === "notion");
  const byId = new Map<string, Row[]>();
  for (const row of rows) {
    const id = new URL(row.url).pathname
      .match(/([a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})(?:\/|$)/i)?.[1]
      ?.replaceAll("-", "");
    if (id) byId.set(id, [...(byId.get(id) ?? []), row]);
  }
  const patches = new Map<Row, Row>();
  return Effect.forEach(
    byId,
    ([id, linked]) =>
      lookup(id).pipe(
        Effect.map((metadata) => {
          for (const row of linked) patches.set(row, { ...row, ...metadata });
        }),
        // Missing access to a page must not prevent the rest of the issue feed from loading.
        Effect.ignoreCause,
      ),
    { concurrency: 3, discard: true },
  ).pipe(
    Effect.map(() =>
      groups.map((group) => ({
        ...group,
        cards: group.cards.map((card) => ({
          ...card,
          ...(card.rows ? { rows: card.rows.map((row) => patches.get(row) ?? row) } : {}),
        })),
      })),
    ),
  );
};
