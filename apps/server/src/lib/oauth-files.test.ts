import { expect, test } from "bun:test";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Option } from "effect";
import { FileProvider, origins, withOAuthLock } from "./mcp";

test("real OAuth file store preserves omitted refresh tokens, rotates privately and binds credentials to issuer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mondash-oauth-"));
  try {
    const provider = new FileProvider("notion", Option.none(), origins(Option.none()), dir);
    await provider.saveTokens({
      access_token: "first",
      refresh_token: "refresh-first",
      token_type: "Bearer",
      issuer: "https://auth.example.com",
    });
    await provider.saveTokens({ access_token: "second", token_type: "Bearer", issuer: "https://auth.example.com" });
    expect((await provider.tokens())?.refresh_token).toBe("refresh-first");
    await provider.saveTokens({
      access_token: "third",
      refresh_token: "refresh-third",
      token_type: "Bearer",
      issuer: "https://auth.example.com",
    });
    expect((await provider.tokens())?.refresh_token).toBe("refresh-third");
    expect(await provider.tokens({ issuer: "https://other.example.com" })).toBeUndefined();
    await provider.saveDiscoveryState({ authorizationServerUrl: "https://auth.example.com" });
    await provider.saveCodeVerifier("private-verifier");
    await provider.state();
    expect((await provider.discoveryState())?.authorizationServerUrl).toBe("https://auth.example.com");
    expect((await stat(join(dir, "notion.json"))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(dir, "notion.json.previous"), "utf8")).tokens.access_token).toBe("third");
    await provider.invalidateCredentials("all");
    expect(await provider.tokens()).toBeUndefined();
    expect(await provider.discoveryState()).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("MCP and direct API credential operations serialize and recover after a failed exchange", async () => {
  let active = 0;
  let maximum = 0;
  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      withOAuthLock("slack", async () => {
        active++;
        maximum = Math.max(maximum, active);
        await Bun.sleep(2);
        active--;
        if (index === 0) throw new Error("synthetic interruption");
      }).catch(() => {}),
    ),
  );
  expect(maximum).toBe(1);
  expect(active).toBe(0);
});
test("configured callback port and origin reject forged forwarded hosts", () => {
  expect(origins(Option.some("https://mac.example.com"), "http://localhost:4567", 4567).all).toEqual([
    "http://localhost:4567",
    "http://127.0.0.1:4567",
    "https://mac.example.com",
  ]);
  expect(() => origins(Option.none(), "https://attacker.example.com", 4567)).toThrow("configured");
});

test("direct API refresh uses persisted SDK discovery once under concurrent rejected-token calls", async () => {
  const { accessToken } = await import("./mcp");
  const { Redacted } = await import("effect");
  const dir = await mkdtemp(join(tmpdir(), "mondash-refresh-"));
  const client = Option.some({ id: "synthetic-client", secret: Redacted.make("synthetic-secret") });
  const issuer = "https://mcp.slack.com";
  const endpoint = "https://slack.com/api/oauth.v2.user.access";
  let calls = 0;
  try {
    const provider = new FileProvider("slack", client, origins(Option.none()), dir);
    await provider.saveDiscoveryState({
      authorizationServerUrl: issuer,
      authorizationServerMetadata: {
        issuer,
        authorization_endpoint: "https://slack.com/oauth/v2_user/authorize",
        token_endpoint: endpoint,
        response_types_supported: ["code"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
      },
    });
    await provider.saveTokens({
      access_token: "rejected",
      refresh_token: "refresh-first",
      token_type: "Bearer",
      issuer,
    });
    const fetchFn: import("@modelcontextprotocol/client").FetchLike = async (url, init) => {
      expect(String(url)).toBe(endpoint);
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("refresh-first");
      calls++;
      return Response.json({
        access_token: "refreshed",
        refresh_token: "refresh-rotated",
        token_type: "Bearer",
        expires_in: 3600,
      });
    };
    const tokens = await Promise.all(
      Array.from({ length: 8 }, () => accessToken("slack", client, "rejected", { directory: dir, fetchFn })),
    );
    expect(tokens).toEqual(Array(8).fill("refreshed"));
    expect(calls).toBe(1);
    expect((await provider.tokens())?.issuer).toBe(issuer);
    expect((await provider.tokens())?.refresh_token).toBe("refresh-rotated");
    expect((await stat(join(dir, "slack.json"))).mode & 0o777).toBe(0o600);
    await provider.state();
    await provider.saveCodeVerifier("pending");
    await provider.completeAuthorization();
    expect((await provider.load()).state).toBeUndefined();
    expect((await provider.load()).verifier).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A second backend must never race the original's rotating refresh credentials.
test("read-only preview rereads owner tokens without refreshing or changing credentials", async () => {
  const { accessToken } = await import("./mcp");
  const dir = await mkdtemp(join(tmpdir(), "mondash-preview-auth-"));
  let refreshes = 0;
  const options = {
    directory: dir,
    readOnly: true,
    fetchFn: async () => {
      refreshes++;
      return Response.json({});
    },
  };
  try {
    const owner = new FileProvider("notion", Option.none(), origins(Option.none()), dir);
    await owner.saveTokens({ access_token: "old", refresh_token: "rotating", token_type: "Bearer", expires_in: 0 });
    const before = await readFile(join(dir, "notion.json"), "utf8");
    expect(
      await Promise.all(Array.from({ length: 8 }, () => accessToken("notion", Option.none(), undefined, options))),
    ).toEqual(Array(8).fill("old"));
    await expect(accessToken("notion", Option.none(), "old", options)).rejects.toThrow("original Mondash");
    expect(refreshes).toBe(0);
    expect(await readFile(join(dir, "notion.json"), "utf8")).toBe(before);
    await owner.saveTokens({ access_token: "new", refresh_token: "rotated", token_type: "Bearer" });
    expect(await accessToken("notion", Option.none(), "old", options)).toBe("new");
    expect((await owner.tokens())?.refresh_token).toBe("rotated");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
