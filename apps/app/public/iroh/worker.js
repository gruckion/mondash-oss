// One encrypted endpoint per browser origin, shared by its tabs.
import init, { BrowserEndpoint, BrowserRequest, ticket_identity } from "./mondash_iroh.js";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let endpoint, mac, initialization;
const wasm = init();
const clients = new Map();

function storage() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("mondash-iroh", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("settings");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(Error("Safari could not save this browser’s pairing. Allow website storage and try again."));
  });
}
async function readSetting(key) {
  const db = await storage();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction("settings").objectStore("settings").get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}
async function writeSetting(key, value) {
  const db = await storage();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction("settings", "readwrite");
      tx.objectStore("settings").put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
function base64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
async function message(frame) {
  const request = new BrowserRequest(endpoint);
  try {
    await request.open(mac.ticket, JSON.stringify({ version: 1, ...frame }));
    let text = "",
      size = 0;
    while (size < 65536) {
      const bytes = await request.read(4096);
      if (!bytes.length) break;
      size += bytes.length;
      text += decoder.decode(bytes, { stream: true });
      if (frame.op === "http-bytes" && text.includes("\r\n")) break;
    }
    if (size >= 65536) throw Error("The Mac returned an invalid pairing response");
    return text;
  } finally {
    request.cancel();
    request.free();
  }
}
async function start(invitation) {
  await wasm;
  const previous = await readSetting("mac");
  if (
    invitation &&
    (!/^[a-f0-9]{64}$/.test(invitation.id) ||
      typeof invitation.ticket !== "string" ||
      typeof invitation.token !== "string")
  )
    throw Error("This Mac invitation is invalid. Create a new link from Mondash on your Mac.");
  if (previous && invitation && previous.id !== invitation.id)
    throw Error("This browser is paired with a different Mac. Use a separate browser profile for the other Mac.");
  mac = invitation ?? previous;
  if (!mac) throw Error("Create a browser invitation from the Mondash menu on your Mac, then open that link here.");
  if (ticket_identity(mac.ticket) !== mac.id)
    throw Error("The Mac identity does not match this invitation. Create a new link from Mondash.");
  let secret = await readSetting("identity");
  if (!secret) {
    secret = crypto.getRandomValues(new Uint8Array(32));
    await writeSetting("identity", secret);
  }
  endpoint = await BrowserEndpoint.bind(secret, mac.ticket);
  try {
    if (invitation) {
      const response = await message({ op: "pair", token: invitation.token });
      if (
        response !== "paired" &&
        response !== "replayed-token" &&
        response !== "expired-token" &&
        response !== "invalid-token"
      )
        throw Error("The Mac has not approved this browser. Create a new invitation in Mondash.");
    }
    const health = await message({
      op: "http-bytes",
      body: base64(encoder.encode("GET /api/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")),
    });
    if (!health.startsWith("HTTP/1.1 200"))
      throw Error("This browser is not paired with your Mac. Create a new invitation from the Mondash menu.");
    const saved = { id: mac.id, ticket: mac.ticket };
    await writeSetting("mac", saved);
    mac = saved;
    return { server: `https://${mac.id}.iroh`, identity: endpoint.identity() };
  } catch (error) {
    await endpoint.close();
    endpoint.free();
    endpoint = undefined;
    throw error;
  }
}
async function initialize(invitation) {
  if (!initialization) {
    initialization = start(invitation).catch((error) => {
      initialization = undefined;
      throw error;
    });
    return initialization;
  }
  const result = await initialization;
  if (!invitation) return result;
  if (invitation.id !== mac.id || ticket_identity(invitation.ticket) !== mac.id)
    throw Error("This browser is paired with a different Mac. Use a separate browser profile for the other Mac.");
  // A fresh owner invitation can restore a revoked pairing without replacing the shared endpoint.
  await message({ op: "pair", token: invitation.token });
  const health = await message({
    op: "http-bytes",
    body: base64(encoder.encode("GET /api/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")),
  });
  if (!health.startsWith("HTTP/1.1 200"))
    throw Error("This invitation expired. Create a new browser invitation from Mondash on your Mac.");
  return result;
}

function closeRequest(entry) {
  entry.closed = true;
  entry.request.cancel();
  if (!entry.pending) entry.request.free();
}
async function operate(entry, fn) {
  entry.pending++;
  try {
    return await fn(entry.request);
  } finally {
    entry.pending--;
    if (entry.closed && !entry.pending) entry.request.free();
  }
}
self.onconnect = (event) => {
  const port = event.ports[0];
  const requests = new Map();
  clients.set(port, requests);
  port.onmessage = async ({ data }) => {
    const { sequence, op, id } = data;
    try {
      let result;
      if (op === "initialize") result = await initialize(data.invitation);
      else if (op === "cancelAll" || op === "disconnect") {
        for (const entry of requests.values()) closeRequest(entry);
        requests.clear();
        if (op === "disconnect") {
          clients.delete(port);
          port.close();
          return;
        }
      } else if (op === "open") {
        if (!endpoint || !mac) throw Error("Open Mondash on your Mac and reconnect.");
        if (requests.has(id) || requests.size >= 24) throw Error("Too many requests. Try again shortly.");
        const entry = { request: new BrowserRequest(endpoint), pending: 0, closed: false };
        requests.set(id, entry);
        try {
          await operate(entry, (request) =>
            request.open(mac.ticket, JSON.stringify({ version: 1, op: "http-bytes", body: base64(data.bytes) })),
          );
        } catch (error) {
          if (requests.get(id) === entry) {
            requests.delete(id);
            closeRequest(entry);
          }
          throw error;
        }
      } else if (op === "read") {
        const entry = requests.get(id);
        if (!entry) throw Error("Request cancelled");
        result = await operate(entry, (request) => request.read(data.limit));
      } else if (op === "cancel") {
        const entry = requests.get(id);
        requests.delete(id);
        if (entry) closeRequest(entry);
      } else throw Error("Unknown transport request");
      port.postMessage({ sequence, result }, result instanceof Uint8Array ? [result.buffer] : []);
    } catch (error) {
      port.postMessage({ sequence, error: String(error instanceof Error ? error.message : error) });
    }
  };
  port.start();
};
