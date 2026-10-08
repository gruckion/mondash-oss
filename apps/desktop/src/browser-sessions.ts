import { createHash, randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const LIFETIME = 30 * 24 * 3_600_000;
const RENEW_AFTER = 24 * 3_600_000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
type Session = { expires: number; renewed: number; name: string };

/** Durable browser grants. Only token hashes reach disk; renewal is carried by ordinary requests. */
export async function browserSessions(data: string) {
  const path = resolve(data, "browser-sessions.json");
  const sessions = new Map<string, Session>();
  try {
    const saved: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof saved !== "object" || saved === null || Array.isArray(saved)) throw Error("Invalid browser grants");
    for (const [id, value] of Object.entries(saved)) {
      if (
        /^[a-f0-9]{64}$/.test(id) &&
        typeof value === "object" &&
        value !== null &&
        "expires" in value &&
        typeof value.expires === "number" &&
        Number.isFinite(value.expires) &&
        "renewed" in value &&
        typeof value.renewed === "number" &&
        Number.isFinite(value.renewed) &&
        "name" in value &&
        typeof value.name === "string" &&
        value.expires > Date.now()
      )
        sessions.set(id, { expires: value.expires, renewed: value.renewed, name: value.name });
    }
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  let writing = Promise.resolve();
  const change = <A>(update: () => A): Promise<A> => {
    const next = writing.then(async () => {
      const before = new Map(sessions);
      const result = update();
      try {
        await writeFile(path + ".new", JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
        await rename(path + ".new", path);
      } catch (error) {
        sessions.clear();
        for (const [id, grant] of before) sessions.set(id, grant);
        throw error;
      }
      return result;
    });
    writing = next.then(
      () => {},
      () => {},
    );
    return next;
  };
  const cookie = (value: string) =>
    `mondash-browser=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${LIFETIME / 1000}`;
  return {
    async create(agent: string) {
      const value = randomBytes(32).toString("hex"),
        now = Date.now();
      const name = /Edg\//.test(agent)
        ? "Edge"
        : /Chrome\//.test(agent)
          ? "Chrome"
          : /Firefox\//.test(agent)
            ? "Firefox"
            : /Safari\//.test(agent)
              ? "Safari"
              : "Browser";
      const id = digest(value);
      await change(() => sessions.set(id, { expires: now + LIFETIME, renewed: now, name }));
      return cookie(value);
    },
    async authorize(header: string | null) {
      const value = header
        ?.split(";")
        .map((s) => s.trim())
        .find((s) => s.startsWith("mondash-browser="))
        ?.slice(16);
      if (!value || !/^[a-f0-9]{64}$/.test(value)) return undefined;
      await writing;
      const id = digest(value),
        grant = sessions.get(id),
        now = Date.now();
      if (!grant || grant.expires <= now) return undefined;
      if (now - grant.renewed < RENEW_AFTER) return { id };
      await change(() => {
        if (sessions.has(id)) sessions.set(id, { ...grant, renewed: now, expires: now + LIFETIME });
      });
      return sessions.has(id) ? { id, cookie: cookie(value) } : undefined;
    },
    list: () =>
      [...sessions]
        .filter(([, grant]) => grant.expires > Date.now())
        .map(([id, grant]) => ({ id, name: `${grant.name} on this Mac` })),
    async revoke(id: string) {
      return change(() => sessions.delete(id));
    },
  };
}
