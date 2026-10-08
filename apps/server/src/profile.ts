import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { Schema } from "effect";

export { Profile, Integration } from "@mondash/shared/setup";
import { Profile, type Integration } from "@mondash/shared/setup";
export const defaultProfile = (): Profile => ({
  version: 1,
  directory: { me: "", people: [] },
  integrations: {
    github: false,
    linear: false,
    slack: false,
    notion: false,
    sessions: false,
    classification: false,
    notifications: false,
    tracing: false,
  },
  workspace: { organizations: [], reviewTeams: [], ticketPrefixes: [], linearWorkspace: "", directories: {} },
  notion: {
    view: "",
    properties: {
      title: "Name",
      status: "Status",
      priority: "Priority",
      owner: "Owner",
      reviewer: "Reviewer",
      effort: "Effort",
      effortDays: "Effort (Days)",
      created: "Created",
      updated: "Last edited time",
    },
    scoping: ["Scoping"],
    open: ["Scoping", "Ready to review"],
    readyToReview: "Ready to review",
  },
  runtime: {
    host: "127.0.0.1",
    port: 3456,
    terminalApp: "Terminal",
    newSessionDir: homedir(),
    expoGoUrl: "",
    publicUrl: "",
  },
});

export function identityDirectory(input: Profile["directory"]) {
  const index = new Map<string, Profile["directory"]["people"][number]>();
  const names = new Map<string, Profile["directory"]["people"][number][]>();
  for (const person of input.people) {
    const ids = [person.email, person.slack, person.github, ...(person.aliases ?? [])].filter(
      (id): id is string => !!id,
    );
    if (!ids.length) throw new Error(`directory.people: ${person.name} needs a provider identifier`);
    for (const id of ids) {
      const old = index.get(id.toLowerCase());
      if (old && old !== person) throw new Error(`directory.people: ambiguous identifier ${id}`);
      index.set(id.toLowerCase(), person);
    }
    names.set(person.name.toLowerCase(), [...(names.get(person.name.toLowerCase()) ?? []), person]);
  }
  const person = (key: string) =>
    index.get(key.toLowerCase()) ??
    (names.get(key.toLowerCase())?.length === 1 ? names.get(key.toLowerCase())?.[0] : undefined);
  if (input.me && !person(input.me)) throw new Error("directory.me must resolve to one explicit person");
  return { person, self: person(input.me) };
}

export function decodeProfile(input: unknown): Profile {
  const profile = Schema.decodeUnknownSync(Profile, { onExcessProperty: "error" })(input);
  identityDirectory(profile.directory);
  for (const path of Object.values(profile.workspace.directories))
    if (!isAbsolute(path)) throw new Error("workspace.directories requires absolute paths");
  for (const team of profile.workspace.reviewTeams)
    if (!profile.workspace.organizations.some((org) => org.toLowerCase() === team.organization.toLowerCase()))
      throw new Error("workspace.reviewTeams organization is outside configured scope");
  const columns = Object.values(profile.notion.properties).filter((p): p is string => p !== null);
  if (new Set(columns).size !== columns.length) throw new Error("notion.properties maps multiple fields to one column");
  for (const status of [
    ...profile.notion.scoping,
    ...(profile.notion.readyToReview ? [profile.notion.readyToReview] : []),
  ])
    if (!profile.notion.open.includes(status)) throw new Error("notion.open must include every actionable status");
  if (
    profile.notion.view &&
    !/^view:\/\/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(profile.notion.view) &&
    (!URL.canParse(profile.notion.view) || new URL(profile.notion.view).protocol !== "https:")
  )
    throw new Error("notion.view must identify a saved Notion view");
  if (profile.workspace.linearWorkspace && !/^[\w.-]+$/.test(profile.workspace.linearWorkspace))
    throw new Error("workspace.linearWorkspace must be a workspace slug");
  if (profile.runtime.publicUrl) {
    const url = new URL(profile.runtime.publicUrl);
    if (url.protocol !== "https:" || url.origin !== profile.runtime.publicUrl || url.username || url.password)
      throw new Error("runtime.publicUrl must be an HTTPS origin without a path or credentials");
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(profile.runtime.host))
    throw new Error("runtime.host must be loopback; use a private reverse proxy for phone access");
  return profile;
}

export const profilePath = () => resolve(process.env.MONDASH_PROFILE ?? "mondash.local.json");
export function readProfile(path = profilePath()): Profile {
  if (!existsSync(path)) return defaultProfile();
  return decodeProfile(JSON.parse(readFileSync(path, "utf8")));
}
// Loaded once at startup. Setup writes are validated atomically and ask the user to restart to activate them.
export const profile = readProfile();
/** A requested integration with its non-secret prerequisite configured. Connection readiness stays separate. */
export const enabled = (name: Integration) => {
  if (!profile.integrations[name]) return false;
  const self = identityDirectory(profile.directory).self;
  if (name === "github") return !!self?.github;
  if (name === "slack") return !!self?.slack;
  if (name === "notion") return !!profile.notion.view;
  return true;
};
export const orgScope = () =>
  profile.workspace.githubPersonalOnly
    ? `user:${identityDirectory(profile.directory).self?.github}`
    : profile.workspace.organizations.map((org) => `org:${org}`).join(" ");
export const ticketUrl = (id: string) =>
  `https://linear.app/${profile.workspace.linearWorkspace}/issue/${encodeURIComponent(id)}`;
export function actionDirectory(owner: string, repository?: string) {
  const entries = Object.entries(profile.workspace.directories);
  const find = (key: string) => entries.find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
  return (repository ? find(`${owner}/${repository}`) : undefined) ?? find(owner);
}

/** Translate configured property names into the canonical shape used by the existing workflow. */
export function notionProperties(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error("Notion row is not an object");
  const raw = input as Record<string, unknown>;
  const names = {
    title: "Name",
    status: "Status",
    priority: "Priority",
    owner: "Assign",
    reviewer: "Reviewer",
    effort: "Effort",
    effortDays: "Effort (Days)",
    created: "Created",
    updated: "Last edited time",
  };
  const result: Record<string, unknown> = { ...raw };
  for (const [field, canonical] of Object.entries(names)) {
    delete result[canonical];
    const column = profile.notion.properties[field as keyof typeof names];
    if (column !== null && raw[column] !== undefined) {
      const value = raw[column];
      result[canonical] =
        (field === "priority" || field === "effort") && typeof value === "number" && Number.isFinite(value)
          ? String(value)
          : value;
    }
  }
  return result;
}
