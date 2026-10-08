import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { defaultProfile, readProfile } from "../profile";
import { notionSchemaFingerprint, parseNotionSchema } from "../lib/settings-notion";
import { privateUpdate } from "../private-files";
import { ServerConfig } from "../config";
import { ConnectionSetup } from "../connection-setup";
import { SettingsManager, withAccount } from "./settings";
import { Store, storeKey } from "./store";
import { Gh, GhFailure } from "./gh";
import { Mcp } from "./mcp";
import { Linear } from "./linear";
import { SlackApi } from "./slack";
import { Dashboard } from "./dashboard";

const unused = Effect.die(new Error("Unexpected provider access"));
const me = {
  source: "github",
  id: "123",
  login: "alex",
  name: "Alex",
  options: [{ id: "Acme", name: "Acme" }],
  complete: true,
} as const;
const dependencies = Layer.mergeAll(
  ServerConfig.layer,
  Layer.succeed(
    Gh,
    Gh.of({
      json: (args, schema) =>
        Effect.gen(function* () {
          if (!(yield* ConnectionSetup))
            return yield* new GhFailure({
              command: args.join(" "),
              cause: "Disabled source bootstrap was not authorized",
            });
          const fixture =
            args[1] === "user" ? { id: 123, login: "alex", name: "Alex", email: null } : [{ login: "Acme" }];
          return yield* Schema.decodeUnknownEffect(schema)(fixture).pipe(
            Effect.mapError((cause) => new GhFailure({ command: args.join(" "), cause })),
          );
        }),
    }),
  ),
  Layer.succeed(Linear, Linear.of({ query: () => unused, connected: false, health: Effect.succeed(undefined) })),
  Layer.succeed(SlackApi, SlackApi.of({ get: () => unused, post: () => unused })),
  Layer.succeed(
    Mcp,
    Mcp.of({
      signIn: () => unused,
      finishSignIn: () => unused,
      call: () => unused,
      cachedCall: () => unused,
      accessToken: () => unused,
      hasTokens: () => unused,
      health: () => unused,
      probe: () => unused,
    }),
  ),
  Layer.succeed(
    Dashboard,
    Dashboard.of({
      section: () => unused,
      health: Effect.succeed({ version: 1, name: "Mondash", at: "2026-10-05T10:00:00.000Z", connections: [] }),
      warm: Effect.void,
    }),
  ),
);

test("provider identity merges preserve colleagues and paid-feature consent, and replacement requires prior disconnection", () => {
  const blank = defaultProfile();
  const colleague = { name: "Taylor", email: "taylor@example.com", github: "taylor" };
  const connected = withAccount({ ...blank, directory: { me: "", people: [colleague] } }, me);
  expect(connected.directory.me).toBe("alex");
  expect(connected.directory.people).toEqual([{ name: "Alex", github: "alex" }, colleague]);
  expect(connected.integrations.github).toBe(true);
  expect(connected.integrations.classification).toBe(false);
  expect(connected.integrations.notifications).toBe(false);
  expect(connected.integrations.tracing).toBe(false);
  expect(() => withAccount(connected, { ...me, id: "456", login: "new-alex" })).toThrow("Disconnect");
  const replaced = withAccount(
    { ...connected, integrations: { ...connected.integrations, github: false } },
    { ...me, id: "456", login: "new-alex" },
  );
  expect(replaced.directory.people[0]?.github).toBe("new-alex");
  expect(replaced.directory.people[1]).toEqual(colleague);
});

test("connect and scope persist atomically with private rollback; scope refresh keeps read state and quota fences", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mondash-settings-"));
  const path = join(directory, "profile.json");
  try {
    await privateUpdate(path, () => defaultProfile());
    let restarts = 0;
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        const settings = yield* SettingsManager.make(path, () => {
          restarts++;
          return false;
        });
        const oldScope = storeKey("github:review-feed:v11", Schema.String);
        const oldPrs = storeKey("github:my-open-prs:v4", Schema.String);
        const read = storeKey("feed:read", Schema.String),
          quota = storeKey("github:cooldown:graphql", Schema.String);
        for (const key of [oldScope, oldPrs, read, quota]) yield* store.write(key, "keep");
        expect(yield* settings.apply({ kind: "connect", source: "github" }).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
        });
        expect(readProfile(path).integrations.github).toBe(false);
        expect(restarts).toBe(0);
        yield* settings.apply({ kind: "connect", source: "github", organizations: ["Acme"], personalOnly: false });
        const saved = readProfile(path);
        expect(saved.workspace.organizations).toEqual(["Acme"]);
        expect(saved.directory.me).toBe("alex");
        expect(saved.integrations.github).toBe(true);
        expect(yield* store.read(oldScope)).toBeUndefined();
        expect(yield* store.read(oldPrs)).toBeUndefined();
        expect((yield* store.read(read))?.value).toBe("keep");
        expect((yield* store.read(quota))?.value).toBe("keep");
        expect(restarts).toBe(1);
        const previous = JSON.parse(yield* Effect.promise(() => readFile(`${path}.previous`, "utf8")));
        expect(previous.integrations.github).toBe(false);
        yield* settings.apply({ kind: "disconnect", source: "github" });
        expect(readProfile(path).integrations.github).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(dependencies, Store.layerMemory))),
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the managed restart barrier rejects overlapping changes after the first accepted update", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mondash-settings-"));
  const path = join(directory, "profile.json");
  try {
    await privateUpdate(path, () => defaultProfile());
    await Effect.runPromise(
      Effect.gen(function* () {
        const settings = yield* SettingsManager.make(path, () => true);
        expect(
          yield* settings.apply({ kind: "connect", source: "github", organizations: [], personalOnly: true }),
        ).toEqual({ restarting: true });
        expect(
          yield* settings.apply({ kind: "feature", name: "sessions", active: true }).pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure" });
        expect(readProfile(path).integrations.sessions).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(dependencies, Store.layerMemory))),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("board application requires explicit unused confirmation for ambiguous ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mondash-settings-"));
  const path = join(directory, "profile.json");
  const source = {
    object: "data_source",
    id: "27542751-ae60-52b5-a819-625829d26167",
    properties: {
      Name: { id: "title", name: "Name", type: "title", title: {} },
      Workflow: {
        id: "state",
        name: "Workflow",
        type: "status",
        status: {
          options: [
            { id: "draft", name: "Scoping" },
            { id: "review", name: "Ready for review" },
          ],
        },
      },
      Responsible: { id: "own", name: "Responsible", type: "people", people: {} },
    },
  };
  const view = "view://07b772d2-1473-57de-88e8-97ca88d843c6";
  const selection = {
    view,
    sourceId: source.id,
    fingerprint: notionSchemaFingerprint(parseNotionSchema(source).schema!),
    roles: {
      title: "title",
      status: "state",
      priority: null,
      owner: null,
      reviewer: null,
      effort: null,
      effortDays: null,
      created: null,
      updated: null,
    },
    stages: { draft: "scoping", review: "review" },
    unusedPeopleRoles: [],
  } as const;
  try {
    await privateUpdate(path, () => defaultProfile());
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        const mcp = yield* Mcp;
        yield* store.write(storeKey(`settings:notion-schema:${view}`, Schema.Unknown), source);
        const settings = yield* SettingsManager.make(path, () => false).pipe(
          Effect.provideService(Mcp, { ...mcp, call: () => Effect.succeed(JSON.stringify(source)) }),
        );
        expect(yield* settings.apply({ kind: "notion", selection }).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
        });
        expect(readProfile(path).integrations.notion).toBe(false);
        yield* settings.apply({
          kind: "notion",
          selection: { ...selection, unusedPeopleRoles: ["owner", "reviewer"] },
        });
        expect(readProfile(path).notion.propertyIds?.owner).toBeNull();
        expect(readProfile(path).integrations.notion).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(dependencies, Store.layerMemory))),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
