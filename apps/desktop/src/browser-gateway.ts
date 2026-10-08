import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { networkInterfaces } from "node:os";
import { browserSessions } from "./browser-sessions";
import { recoveryPage, recoveryScript, recoveryWorker } from "./browser-recovery";

interface Configuration {
  backend: string;
  capability: string;
  webRoot: string;
  data: string;
  lan?: string;
  browserOrigin?: string;
}
const token = () => randomBytes(32).toString("hex");
const htmlHeaders = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
const equal = (value: string | null, expected: string) =>
  Boolean(
    value &&
    /^[a-f0-9]{64}$/.test(value) &&
    value.length === expected.length &&
    timingSafeEqual(Buffer.from(value), Buffer.from(expected)),
  );

/** Browser sessions never receive the backend capability; the public client has no API proxy. */
export async function startBrowserGateway(config: Configuration) {
  await mkdir(config.data, { recursive: true, mode: 0o700 });
  const invites = new Map<string, number>();
  const sessions = await browserSessions(config.data);
  const requests = new Map<
    string,
    { verifier: string; expires: number; agent: string; cookie?: string; approval?: Promise<string> }
  >();
  const streams = new Map<string, Set<AbortController>>();
  const revoke = async (id: string) => {
    if (!(await sessions.revoke(id))) return false;
    for (const stream of streams.get(id) ?? []) stream.abort();
    streams.delete(id);
    return true;
  };
  const savedPort = resolve(config.data, "browser-port.json");
  let port = 0;
  try {
    const saved: unknown = JSON.parse(await readFile(savedPort, "utf8"));
    if (typeof saved === "number" && Number.isInteger(saved) && saved > 1024 && saved < 65536) port = saved;
  } catch {}
  let local: ReturnType<typeof Bun.serve>;
  let remoteOrigin: string | undefined;
  let ownerCommand = Promise.resolve();
  const command = (action: string, id?: string): Promise<Record<string, string>> => {
    const execute = async () => {
      const nonce = token();
      const filename = resolve(config.data, "pairing-command.json");
      await writeFile(filename + ".new", JSON.stringify({ nonce, action, id }), { mode: 0o600 });
      await rename(filename + ".new", filename);
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          const reply = JSON.parse(await readFile(resolve(config.data, "pairing-response.json"), "utf8"));
          if (reply.nonce === nonce) return reply;
        } catch {}
        await Bun.sleep(50);
      }
      throw new Error("Mac connection is starting. Try again shortly.");
    };
    const result = ownerCommand.then(execute);
    ownerCommand = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const localFetch = async (req: Request) => {
    const origin = `http://127.0.0.1:${local.port}`;
    const path = new URL(req.url).pathname;
    if (req.headers.get("host") !== new URL(origin).host) return new Response("Invalid host", { status: 403 });
    const changing = !["GET", "HEAD"].includes(req.method);
    if (changing && req.headers.get("origin") !== origin)
      return new Response("Cross-site action rejected", { status: 403 });
    if (changing && !req.headers.get("content-type")?.startsWith("application/json"))
      return new Response("Send JSON", { status: 415 });
    if (path === "/_browser/worker.js" && req.method === "GET")
      return new Response(recoveryWorker, {
        headers: { "content-type": "text/javascript", "cache-control": "no-cache", "service-worker-allowed": "/" },
      });
    if (path === "/_browser/recovery.js" && req.method === "GET")
      return new Response(recoveryScript, {
        headers: { "content-type": "text/javascript", "cache-control": "no-store" },
      });
    if (path === "/_browser/request" && req.method === "POST") {
      const id = token(),
        verifier = token();
      requests.set(id, { verifier, expires: Date.now() + 120_000, agent: req.headers.get("user-agent") ?? "" });
      return Response.json(
        { url: `mondash://browser?request=${id}` },
        {
          headers: {
            "cache-control": "no-store",
            "set-cookie": `mondash-browser-request=${verifier}; Path=/_browser; HttpOnly; SameSite=Lax; Max-Age=120`,
          },
        },
      );
    }
    if (path === "/_browser/approve" && req.method === "POST") {
      if (!equal(req.headers.get("x-mondash-capability"), config.capability))
        return new Response("Unauthorized", { status: 401 });
      let id: unknown;
      try {
        id = (await req.json()).id;
      } catch {}
      const request = typeof id === "string" ? requests.get(id) : undefined;
      if (!request || request.expires <= Date.now()) return new Response("This request expired", { status: 410 });
      request.approval ??= sessions.create(request.agent);
      try {
        request.cookie = await request.approval;
      } catch (error) {
        request.approval = undefined;
        throw error;
      }
      return Response.json({ approved: true }, { headers: { "cache-control": "no-store" } });
    }
    if (path === "/_handoff/mint" && req.method === "POST") {
      if (!equal(req.headers.get("x-mondash-capability"), config.capability))
        return new Response("Unauthorized", { status: 401 });
      const key = token();
      invites.set(key, Date.now() + 60_000);
      return Response.json({ url: `${origin}/_handoff#${key}` }, { headers: { "cache-control": "no-store" } });
    }
    if (path === "/_pairing/mint" && req.method === "POST") {
      if (!equal(req.headers.get("x-mondash-capability"), config.capability))
        return new Response("Unauthorized", { status: 401 });
      if (!remoteOrigin) return new Response("Connect the Mac to Wi-Fi first", { status: 503 });
      try {
        const reply = await command("invite");
        const invitation = { id: reply.id, ticket: reply.ticket, token: reply.token };
        return Response.json(
          {
            url: `${remoteOrigin}/issues#mondash=${encodeURIComponent(JSON.stringify(invitation))}`,
            expiresInSeconds: 120,
          },
          { headers: { "cache-control": "no-store" } },
        );
      } catch {
        return new Response("Mac connection is starting. Try again shortly.", { status: 503 });
      }
    }
    if ((path === "/_pairing/list" || path === "/_pairing/revoke") && req.method === "POST") {
      if (!equal(req.headers.get("x-mondash-capability"), config.capability))
        return new Response("Unauthorized", { status: 401 });
      if (path.endsWith("/list")) {
        let peers: string[] = [];
        try {
          peers = JSON.parse(await readFile(resolve(config.data, "iroh-pairings.json"), "utf8"));
        } catch {}
        const browsers = sessions.list();
        return Response.json(
          { peers: [...peers, ...browsers.map((browser) => browser.id)], browsers },
          { headers: { "cache-control": "no-store" } },
        );
      }
      let id: unknown;
      try {
        id = (await req.json()).id;
      } catch {}
      if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) return new Response("Invalid device", { status: 400 });
      try {
        if (await revoke(id)) return Response.json({ revoked: true }, { headers: { "cache-control": "no-store" } });
        await command("revoke", id);
        return Response.json({ revoked: true }, { headers: { "cache-control": "no-store" } });
      } catch {
        return new Response("Could not remove device. Try again shortly.", { status: 503 });
      }
    }
    if (path === "/_handoff" && req.method === "GET")
      return new Response(
        `<!doctype html><title>Mondash</title><p>Opening Mondash…</p><script>const next=({settings:'/settings','connect-slack':'/api/auth/slack/start','connect-notion':'/api/auth/notion/start','connect-claude':'/auth/claude'})[new URL(location.href).searchParams.get('next')]||'/issues';const token=location.hash.slice(1);history.replaceState(null,'','/_handoff');fetch('/_handoff/redeem',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token})}).then(r=>{if(!r.ok)throw Error();location.replace(next)}).catch(()=>document.querySelector('p').textContent='This link expired. Choose Open in browser from Mondash’s Mac menu again.');</script>`,
        {
          headers: {
            ...htmlHeaders,
            "content-security-policy":
              "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
          },
        },
      );
    if (path === "/_handoff/redeem" && req.method === "POST") {
      let key: unknown;
      try {
        key = (await req.json()).token;
      } catch {
        return new Response("Invalid invitation", { status: 400 });
      }
      if (typeof key !== "string") return new Response("Invalid invitation", { status: 401 });
      const expires = invites.get(key);
      invites.delete(key);
      if (!expires || expires <= Date.now()) return new Response("This invitation expired", { status: 401 });
      return new Response("Opened", {
        headers: {
          "set-cookie": await sessions.create(req.headers.get("user-agent") ?? ""),
          "cache-control": "no-store",
        },
      });
    }
    let session = await sessions.authorize(req.headers.get("cookie"));
    if (path === "/_browser/status" && req.method === "GET") {
      const headers: Record<string, string> = { "cache-control": "no-store" };
      if (!session) {
        const verifier = req.headers
          .get("cookie")
          ?.split(";")
          .map((value) => value.trim())
          .find((value) => value.startsWith("mondash-browser-request="))
          ?.slice(24);
        const pending = [...requests].find(
          ([, request]) => request.expires > Date.now() && equal(verifier ?? null, request.verifier),
        );
        if (pending) {
          if (!pending[1].cookie) return Response.json({ state: "approving" }, { status: 202, headers });
          session = await sessions.authorize(pending[1].cookie);
          if (session) headers["set-cookie"] = pending[1].cookie;
          requests.delete(pending[0]);
        }
      }
      if (session?.cookie) headers["set-cookie"] = session.cookie;
      if (!session) return Response.json({ state: "reconnect" }, { status: 401, headers });
      const ready = await fetch(new URL("/api/health", config.backend), {
        headers: { "x-mondash-capability": config.capability },
        signal: AbortSignal.timeout(2000),
      })
        .then((response) => response.ok)
        .catch(() => false);
      return Response.json({ state: ready ? "ready" : "starting" }, { status: ready ? 200 : 503, headers });
    }
    if (!session) return new Response(recoveryPage, { status: 401, headers: htmlHeaders });
    if (path === "/_handoff/logout" && req.method === "POST") {
      await revoke(session.id);
      return new Response("Signed out", {
        headers: { "set-cookie": "mondash-browser=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" },
      });
    }
    if (path.startsWith("/_handoff") || path.startsWith("/_pairing") || path.startsWith("/_browser"))
      return new Response("Not found", { status: 404 });
    const target = new URL(req.url);
    target.host = new URL(config.backend).host;
    const headers = new Headers(req.headers);
    for (const name of ["cookie", "host", "x-mondash-capability"]) headers.delete(name);
    headers.set("x-mondash-capability", config.capability);
    headers.set("x-forwarded-host", new URL(origin).host);
    headers.set("x-forwarded-proto", "http");
    if (changing) headers.set("origin", config.backend);
    const streaming = path === "/api/stream";
    const controller = new AbortController();
    const readers = streams.get(session.id) ?? new Set<AbortController>();
    if (streaming) {
      readers.add(controller);
      streams.set(session.id, readers);
    }
    const finished = () => {
      readers.delete(controller);
      if (!readers.size) streams.delete(session.id);
    };
    const response = await fetch(target, {
      method: req.method,
      headers,
      body: changing ? req.body : undefined,
      redirect: "manual",
      signal: streaming ? AbortSignal.any([req.signal, controller.signal]) : req.signal,
    }).catch(
      () =>
        new Response(path.startsWith("/api/") ? "Mondash is starting" : recoveryPage, {
          status: 503,
          headers: path.startsWith("/api/") ? { "cache-control": "no-store" } : htmlHeaders,
        }),
    );
    const outgoing = new Headers(response.headers);
    outgoing.delete("set-cookie");
    if (session.cookie) outgoing.set("set-cookie", session.cookie);
    outgoing.set("cache-control", "no-store");
    outgoing.set("referrer-policy", "no-referrer");
    const page = req.method === "GET" && outgoing.get("content-type")?.startsWith("text/html") && response.ok;
    let body: BodyInit | null = page
      ? (await response.text()).replace("<head>", '<head><script src="/_browser/recovery.js"></script>')
      : response.body;
    if (page) outgoing.delete("content-length");
    if (streaming && response.body) {
      const reader = response.body.getReader();
      body = new ReadableStream({
        async pull(output) {
          try {
            const item = await reader.read();
            if (item.done) {
              finished();
              output.close();
            } else output.enqueue(item.value);
          } catch {
            finished();
            output.close();
          }
        },
        async cancel() {
          controller.abort();
          finished();
          await reader.cancel().catch(() => {});
        },
      });
    } else if (streaming) finished();
    return new Response(body, { status: response.status, headers: outgoing });
  };
  try {
    local = Bun.serve({ hostname: "127.0.0.1", port, fetch: localFetch });
  } catch (error) {
    if (!port || !(error instanceof Error) || !("code" in error) || error.code !== "EADDRINUSE") throw error;
    local = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: localFetch });
  }
  await writeFile(savedPort, JSON.stringify(local.port), { mode: 0o600 });
  const lan =
    config.lan ??
    Object.entries(networkInterfaces())
      .filter(([name]) => !name.startsWith("utun"))
      .flatMap(([, addresses]) => addresses ?? [])
      .find((a) => a.family === "IPv4" && !a.internal && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address))
      ?.address;
  let publicClient: ReturnType<typeof Bun.serve> | undefined;
  if (lan) {
    let lanPort = 8085;
    const portFile = resolve(config.data, "browser-lan-port.json");
    try {
      const saved: unknown = JSON.parse(await readFile(portFile, "utf8"));
      if (typeof saved === "number" && Number.isInteger(saved) && saved > 1024 && saved < 65536) lanPort = saved;
    } catch {}
    const serve = (port: number) =>
      Bun.serve({
        hostname: lan,
        port,
        async fetch(req) {
          if (req.headers.get("host") !== `${lan}:${publicClient?.port ?? port}` || req.method !== "GET")
            return new Response("Not found", { status: 404 });
          const path = new URL(req.url).pathname;
          if (
            path.startsWith("/api/") ||
            path.startsWith("/_handoff") ||
            path.startsWith("/_pairing") ||
            path.startsWith("/_browser")
          )
            return new Response("Not found", { status: 404 });
          let filename: string;
          try {
            filename = resolve(config.webRoot, "." + decodeURIComponent(path));
          } catch {
            return new Response("Not found", { status: 404 });
          }
          if (filename === resolve(config.webRoot)) filename = resolve(config.webRoot, "index.html");
          if (!filename.startsWith(resolve(config.webRoot) + sep)) return new Response("Not found", { status: 404 });
          let file = Bun.file(filename);
          if (!(await file.exists())) file = Bun.file(resolve(config.webRoot, "index.html"));
          if (file.type.startsWith("text/html")) {
            const nonce = token();
            const page = (await file.text())
              .replace(
                "<head>",
                `<head><script nonce="${nonce}">localStorage.setItem('mondash:browser:iroh','1')</script>`,
              )
              .replace(/<script(?![^>]*\bnonce=)/g, `<script nonce="${nonce}"`);
            return new Response(page, {
              headers: {
                ...htmlHeaders,
                "content-security-policy": `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' wss:; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; base-uri 'none'; frame-ancestors 'none'`,
              },
            });
          }
          return new Response(file, {
            headers: {
              "content-type": file.type,
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
              "referrer-policy": "no-referrer",
            },
          });
        },
      });
    try {
      publicClient = serve(lanPort);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EADDRINUSE") publicClient = serve(0);
      else console.warn("Mondash browser access on Wi-Fi is unavailable; local browser access remains available.");
    }
    if (publicClient) await writeFile(portFile, JSON.stringify(publicClient.port), { mode: 0o600 });
  }
  remoteOrigin = config.browserOrigin ?? (publicClient ? `http://${lan}:${publicClient.port}` : undefined);
  const state = { localOrigin: `http://127.0.0.1:${local.port}`, remoteOrigin };
  await writeFile(resolve(config.data, "browser-gateway.json"), JSON.stringify(state), { mode: 0o600 });
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, until] of invites) if (until <= now) invites.delete(key);
    for (const [key, request] of requests) if (request.expires <= now) requests.delete(key);
  }, 60_000);
  cleanup.unref();
  return {
    ...state,
    stop() {
      clearInterval(cleanup);
      local.stop(true);
      publicClient?.stop(true);
    },
  };
}
