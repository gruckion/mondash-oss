import { expect, test, setSystemTime } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { startBrowserGateway } from "./browser-gateway";

// The independent boundary is the browser session/proxy, not the Effect API's data contract.
test("browser sessions hide the backend capability and the remote client has no HTTP API", async () => {
  const data = await mkdtemp(resolve(tmpdir(), "mondash-browser-"));
  const webRoot = resolve(data, "web");
  await mkdir(resolve(webRoot, "_expo"), { recursive: true });
  await writeFile(resolve(webRoot, "index.html"), "<!doctype html><head></head><body>Mondash</body>");
  await writeFile(resolve(webRoot, "_expo", "app.js"), "// bundled client");
  const capability = "a".repeat(64);
  let healthy = true;
  const forwarded: {
    capability: string | null;
    cookie: string | null;
    origin: string | null;
    host: string | null;
    protocol: string | null;
  }[] = [];
  const backend = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      if (!healthy) return new Response("Starting", { status: 503 });
      forwarded.push({
        capability: req.headers.get("x-mondash-capability"),
        cookie: req.headers.get("cookie"),
        origin: req.headers.get("origin"),
        host: req.headers.get("x-forwarded-host"),
        protocol: req.headers.get("x-forwarded-proto"),
      });
      return new Response("private backend response", { headers: { "set-cookie": `private=${capability}` } });
    },
  });
  const backendOrigin = `http://127.0.0.1:${backend.port}`;
  let gateway: Awaited<ReturnType<typeof startBrowserGateway>> | undefined;
  try {
    gateway = await startBrowserGateway({ backend: backendOrigin, capability, webRoot, data, lan: "127.0.0.1" });
    const origin = gateway.localOrigin;
    const post = (path: string, body: unknown, headers: HeadersInit = {}) =>
      fetch(origin + path, {
        method: "POST",
        headers: { origin, "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    expect((await fetch(origin + "/api/health")).status).toBe(401);
    expect((await fetch(origin + "/", { headers: { cookie: `mondash-browser=${capability}` } })).status).toBe(401);
    expect((await post("/_handoff/mint", {})).status).toBe(401);
    expect(
      (await post("/_handoff/mint", {}, { origin: "https://other.invalid", "x-mondash-capability": capability }))
        .status,
    ).toBe(403);
    const minted = await post("/_handoff/mint", {}, { "x-mondash-capability": capability });
    expect(minted.status).toBe(200);
    const { url } = await minted.json();
    const token = new URL(url).hash.slice(1);
    const redeemed = await post("/_handoff/redeem", { token });
    expect(redeemed.status).toBe(200);
    const cookie = redeemed.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain(capability);
    expect((await post("/_handoff/redeem", { token })).status).toBe(401);
    const session = cookie.split(";")[0];
    const saved = await readFile(resolve(data, "browser-sessions.json"), "utf8");
    expect(saved).not.toContain(session.slice(16));
    expect((await stat(resolve(data, "browser-sessions.json"))).mode & 0o777).toBe(0o600);
    expect((await fetch(origin + "/_browser/status")).status).toBe(401);
    expect((await fetch(origin + "/_browser/worker.js")).headers.get("service-worker-allowed")).toBe("/");
    const response = await fetch(origin + "/api/health", {
      headers: {
        cookie: session,
        "x-mondash-capability": "forged",
        "x-forwarded-host": "attacker.invalid",
        "x-forwarded-proto": "https",
      },
    });
    expect(await response.text()).toBe("private backend response");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(forwarded.at(-1)).toEqual({
      capability,
      cookie: null,
      origin: null,
      host: new URL(origin).host,
      protocol: "http",
    });
    expect((await post("/api/action", {}, { cookie: session, origin: "https://other.invalid" })).status).toBe(403);
    expect((await post("/api/action", {}, { cookie: session })).status).toBe(200);
    expect(forwarded.at(-1)?.origin).toBe(backendOrigin);
    expect((await fetch(origin + "/api/health", { headers: { host: "other.invalid", cookie: session } })).status).toBe(
      403,
    );
    expect((await fetch(gateway.remoteOrigin + "/api/health")).status).toBe(404);
    expect((await fetch(gateway.remoteOrigin + "/_handoff/mint")).status).toBe(404);
    expect((await fetch(gateway.remoteOrigin + "/_expo/app.js")).status).toBe(200);
    const page = await fetch(gateway.remoteOrigin + "/issues");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("wasm-unsafe-eval");
    expect(await page.text()).not.toContain(capability);
    gateway.stop();
    gateway = await startBrowserGateway({ backend: backendOrigin, capability, webRoot, data, lan: "127.0.0.1" });
    expect((await fetch(gateway.localOrigin + "/api/health", { headers: { cookie: session } })).status).toBe(200);
    healthy = false;
    const starting = await fetch(origin + "/_browser/status", { headers: { cookie: session } });
    expect(starting.status).toBe(503);
    expect(await starting.json()).toEqual({ state: "starting" });
    healthy = true;
    const now = Date.now(),
      day = 24 * 3_600_000;
    try {
      setSystemTime(now + 29 * day);
      const renewed = await fetch(origin + "/_browser/status", { headers: { cookie: session } });
      expect(renewed.status).toBe(200);
      expect(renewed.headers.get("set-cookie")).toContain("Max-Age=2592000");
      gateway.stop();
      gateway = await startBrowserGateway({ backend: backendOrigin, capability, webRoot, data, lan: "127.0.0.1" });
      setSystemTime(now + 31 * day);
      expect((await fetch(origin + "/api/health", { headers: { cookie: session } })).status).toBe(200);
      setSystemTime(now + 62 * day);
      expect((await fetch(origin + "/_browser/status", { headers: { cookie: session } })).status).toBe(401);
    } finally {
      setSystemTime();
    }
    const { url: ownerUrl } = await (await post("/_handoff/mint", {}, { "x-mondash-capability": capability })).json();
    const ownerCookie = (await post("/_handoff/redeem", { token: new URL(ownerUrl).hash.slice(1) })).headers
      .get("set-cookie")!
      .split(";")[0];
    const devices = await (await post("/_pairing/list", {}, { "x-mondash-capability": capability })).json();
    expect(devices.browsers.length).toBe(2);
    const ownerToken = ownerCookie.slice(16);
    const ownerId = new Bun.CryptoHasher("sha256").update(ownerToken).digest("hex");
    expect((await post("/_pairing/revoke", { id: ownerId }, { "x-mondash-capability": capability })).status).toBe(200);
    gateway.stop();
    gateway = await startBrowserGateway({ backend: backendOrigin, capability, webRoot, data, lan: "127.0.0.1" });
    expect((await fetch(origin + "/_browser/status", { headers: { cookie: ownerCookie } })).status).toBe(401);
    expect((await fetch(origin + "/_browser/status", { headers: { cookie: session } })).status).toBe(200);
    const request = await post("/_browser/request", {});
    const requestCookie = request.headers.get("set-cookie")!.split(";")[0];
    const { url: requestUrl } = await request.json();
    const requestId = new URL(requestUrl).searchParams.get("request");
    expect((await fetch(origin + "/_browser/status", { headers: { cookie: requestCookie } })).status).toBe(202);
    expect((await post("/_browser/approve", { id: requestId })).status).toBe(401);
    const approvals = await Promise.all(
      [1, 2].map(() => post("/_browser/approve", { id: requestId }, { "x-mondash-capability": capability })),
    );
    expect(approvals.map((response) => response.status)).toEqual([200, 200]);
    expect(
      (await (await post("/_pairing/list", {}, { "x-mondash-capability": capability })).json()).browsers.length,
    ).toBe(2);
    expect((await fetch(origin + "/_browser/status")).status).toBe(401);
    const approval = await fetch(origin + "/_browser/status", { headers: { cookie: requestCookie } });
    expect(approval.status).toBe(200);
    const reconnected = approval.headers.get("set-cookie")!.split(";")[0];
    expect((await fetch(origin + "/api/health", { headers: { cookie: reconnected } })).status).toBe(200);
    expect((await fetch(origin + "/_browser/status", { headers: { cookie: requestCookie } })).status).toBe(401);
    expect((await post("/_handoff/logout", {}, { cookie: session })).status).toBe(200);
    expect((await fetch(origin + "/api/health", { headers: { cookie: session } })).status).toBe(401);
    const occupiedPort = new URL(gateway.remoteOrigin!).port;
    gateway.stop();
    const occupied = Bun.serve({
      hostname: "127.0.0.1",
      port: Number(occupiedPort),
      fetch: () => new Response("other app"),
    });
    try {
      gateway = await startBrowserGateway({ backend: backendOrigin, capability, webRoot, data, lan: "127.0.0.1" });
      expect(new URL(gateway.remoteOrigin!).port).not.toBe(occupiedPort);
      expect((await fetch(gateway.localOrigin + "/api/health")).status).toBe(401);
      expect((await fetch(gateway.remoteOrigin + "/issues")).status).toBe(200);
    } finally {
      occupied.stop(true);
    }
  } finally {
    gateway?.stop();
    backend.stop(true);
    await rm(data, { recursive: true, force: true });
  }
});
