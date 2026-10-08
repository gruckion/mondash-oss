import { createIrohFetch, type ApiFetch, type IrohBridge } from "./iroh-http";

type Invitation = { id: string; ticket: string; token: string };
const modeKey = "mondash:browser:iroh";
let invitation: Invitation | undefined;
let invitationError: Error | undefined;
const bootstrap = typeof window !== "undefined" ? (window as Window & { __mondashInvitation?: string }) : undefined;
const fragment =
  bootstrap?.__mondashInvitation ??
  (typeof window !== "undefined" && window.location.hash.startsWith("#mondash=")
    ? window.location.hash.slice("#mondash=".length)
    : undefined);
if (bootstrap) delete bootstrap.__mondashInvitation;
if (typeof window !== "undefined" && fragment !== undefined) {
  window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  try {
    invitation = JSON.parse(decodeURIComponent(fragment));
    window.localStorage.setItem(modeKey, "1");
  } catch {
    invitationError = new Error("This invitation is invalid. Create a new link from Mondash on your Mac.");
  }
}
export const usesIroh = (() => {
  if (invitation || invitationError) return true;
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(modeKey) === "1";
  } catch {
    return false;
  }
})();
let worker: SharedWorker | undefined;
let nextSequence = 0;
const pending = new Map<
  number,
  { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
>();
let connection: { server: string; fetch: ApiFetch } | undefined;
let initializing: Promise<string | undefined> | undefined;

function fail(error: Error) {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  pending.clear();
}
function channel() {
  if (worker) return worker.port;
  if (typeof SharedWorker === "undefined")
    throw new Error("Use Safari 16 or later, Chrome, or Firefox to connect this browser to your Mac.");
  worker = new SharedWorker("/iroh/worker.js", { type: "module", name: "mondash-iroh" });
  worker.onerror = () => {
    fail(new Error("Mondash could not start its connection. Reload the page and try again."));
    worker?.port.close();
    worker = undefined;
    initializing = undefined;
  };
  worker.port.onmessage = ({ data }: MessageEvent<{ sequence: number; error?: string; result?: unknown }>) => {
    const request = pending.get(data.sequence);
    if (!request) return;
    pending.delete(data.sequence);
    clearTimeout(request.timer);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.result);
  };
  worker.port.start();
  window.addEventListener(
    "pagehide",
    () => {
      worker?.port.postMessage({ op: "disconnect" });
      worker?.port.close();
      worker = undefined;
      initializing = undefined;
      fail(new DOMException("Page closed", "AbortError"));
    },
    { once: true },
  );
  return worker.port;
}
function call(op: string, fields: Record<string, unknown> = {}, timeout = 45_000): Promise<unknown> {
  const port = channel();
  const sequence = ++nextSequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(sequence);
      if (typeof fields.id === "string") port.postMessage({ op: "cancel", id: fields.id });
      reject(new Error("The Mac took too long to respond. Open Mondash on your Mac and try again."));
    }, timeout);
    pending.set(sequence, { resolve, reject, timer });
    port.postMessage({ sequence, op, ...fields });
  });
}
const bridge: IrohBridge = {
  open: async (id, _ticket, bytes) => {
    await call("open", { id, bytes });
  },
  read: async (id, limit) => {
    const value = await call("read", { id, limit }, 180_000);
    if (!(value instanceof Uint8Array)) throw new Error("Invalid response from Mac");
    return value;
  },
  cancel: async (id) => {
    await call("cancel", { id });
  },
};
export function connectPairedMac(): Promise<string | undefined> {
  if (!usesIroh) return Promise.resolve(undefined);
  if (initializing) return initializing;
  initializing = (async () => {
    if (invitationError) throw invitationError;
    const result = await call("initialize", { invitation });
    if (typeof result !== "object" || !result || !("server" in result) || typeof result.server !== "string")
      throw new Error("Invalid Mac connection");
    const server = result.server;
    connection = { server, fetch: createIrohFetch(bridge, "", server) };
    invitation = undefined;
    return server;
  })().catch((error: unknown) => {
    initializing = undefined;
    throw error;
  });
  return initializing;
}
export const fetchFor = (server: string): ApiFetch => {
  if (!new URL(server).hostname.endsWith(".iroh")) return globalThis.fetch;
  return async (input, options) => {
    await connectPairedMac();
    if (!connection || connection.server !== server) throw new Error("This browser is not connected to that Mac.");
    return connection.fetch(input, options);
  };
};
export const closeNativeRequests = async () => {
  if (worker) await call("cancelAll");
};
export const recordTransportDiagnostics = async (_data: unknown) => {};
