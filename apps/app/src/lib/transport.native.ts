import { requireOptionalNativeModule } from "expo";
import Constants from "expo-constants";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { fetch } from "expo/fetch";
import { createIrohFetch, type ApiFetch, type IrohBridge } from "./iroh-http";

interface NativeIroh extends IrohBridge {
  pair(id: string, ticket: string, token: string): Promise<string>;
  cancelAll(): Promise<void>;
  recordDiagnostics(json: string): Promise<void>;
}
const native = requireOptionalNativeModule<NativeIroh>("MondashIroh");
const key = "mondash:iroh:paired-mac";
let connection: { server: string; fetch: ApiFetch } | undefined;
let initializing: Promise<string | undefined> | undefined;
const bootstrap: unknown = Constants.expoConfig?.extra?.irohPairing;
export const usesIroh = Boolean(bootstrap);

/** The private trial is enrolled by its one-use invitation. Subsequent starts verify retained authorization. */
export function connectPairedMac(): Promise<string | undefined> {
  if (!usesIroh) return Promise.resolve(undefined);
  if (initializing) return initializing;
  initializing = (async () => {
    if (!native) throw new Error("Install the Mondash iPhone build that includes Iroh.");
    if (
      typeof bootstrap !== "object" ||
      !bootstrap ||
      !("ticket" in bootstrap) ||
      !("token" in bootstrap) ||
      typeof bootstrap.ticket !== "string" ||
      typeof bootstrap.token !== "string"
    )
      throw new Error("Mac invitation is invalid.");
    if (!("id" in bootstrap) || typeof bootstrap.id !== "string" || !/^[a-f0-9]{64}$/.test(bootstrap.id))
      throw new Error("Mac identity is invalid.");
    const { ticket, token, id } = bootstrap;
    const server = `https://${id}.iroh`;
    const old = await AsyncStorage.getItem(key);
    if (old && old !== server) throw new Error("This app is paired with a different Mac.");
    let authorizing: Promise<void> | undefined;
    let authorized = false;
    const wire = createIrohFetch(native, ticket, server);
    connection = {
      server,
      fetch: async (input, options) => {
        if (!authorized) {
          authorizing ??= native
            .pair(`pair-${Date.now()}`, ticket, token)
            .then((actual) => {
              if (actual !== id) throw new Error("Mac identity did not match its invitation.");
              authorized = true;
            })
            .finally(() => {
              authorizing = undefined;
            });
          await waitForAuthorization(authorizing, options?.signal);
        }
        return wire(input, options);
      },
    };
    await AsyncStorage.setItem(key, server);
    return server;
  })().catch((error: unknown) => {
    initializing = undefined;
    throw error;
  });
  return initializing;
}

export const fetchFor = (server: string): ApiFetch => {
  if (connection?.server === server) return connection.fetch;
  if (new URL(server).hostname.endsWith(".iroh")) {
    return async (input, init) => {
      await connectPairedMac();
      if (!connection || connection.server !== server)
        throw new Error("Open Mondash on your paired Mac, then try again.");
      return connection.fetch(input, init);
    };
  }
  return fetch;
};
export const closeNativeRequests = async () => {
  await native?.cancelAll();
};
export const recordTransportDiagnostics = async (data: unknown) => {
  if (usesIroh) await native?.recordDiagnostics(JSON.stringify({ ...Object(data), at: new Date().toISOString() }));
};

/** A caller can stop waiting without cancelling another caller's shared authorization. */
function waitForAuthorization(pending: Promise<void>, signal?: AbortSignal | null): Promise<void> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.reject(new DOMException("Request cancelled", "AbortError"));
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new DOMException("Request cancelled", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
