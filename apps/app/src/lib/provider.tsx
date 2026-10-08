import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, AppState, Platform, Pressable, Text, View } from "react-native";
import { useIsFocused } from "expo-router";
import Constants from "expo-constants";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { focusManager, QueryClient, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import { Exit, Schema } from "effect";
import { SectionName, SectionResponse } from "@mondash/shared/contract";
import { archiveSession, isTimeout, loadHealth, loadSection, markFeedRead, normalizeServer } from "./api";
import { startSectionStream, type Connection } from "./section-stream";
import { closeNativeRequests, connectPairedMac, fetchFor, recordTransportDiagnostics, usesIroh } from "./transport";

import { isMacBrowser, readClaudeTarget, type ClaudeTarget } from "./claude-target";

const client = new QueryClient({
  defaultOptions: {
    queries: { retry: (failures, error) => failures < 1 && !isTimeout(error), staleTime: 20000, gcTime: Infinity },
  },
});
const Settings = createContext<{
  server: string;
  macDesktop: boolean;
  claudeTarget: ClaudeTarget;
  setClaudeTarget: (target: ClaudeTarget) => Promise<void>;
  ready: boolean;
  setServer: (value: string) => Promise<void>;
  /** Asks the Mac for a section again after an action, unless the stream will bring the change anyway. */
  refreshSection: (section: SectionName) => void;
} | null>(null);
/** Apart from Settings, so a change of connection re-renders only what shows or depends on it. */
const ConnectionContext = createContext<Connection>("connecting");
const BrowserRecoveryContext = createContext(false);
const ProviderHealthContext = createContext<ReturnType<typeof useHealthQuery> | null>(null);

function useHealthQuery() {
  const { server, ready } = useSettings();
  const recovering = use(BrowserRecoveryContext);
  return useQuery({
    queryKey: ["health", server],
    queryFn: ({ signal }) => loadHealth(server, signal),
    enabled: ready && Boolean(server) && !recovering,
    staleTime: 15000,
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
  });
}

/** One health poll shared by the headers and Settings, even while the section stream is live. */
function ProviderHealth({ children }: { children: ReactNode }) {
  const health = useHealthQuery();
  return <ProviderHealthContext value={health}>{children}</ProviderHealthContext>;
}

export function useProviderHealth() {
  const health = use(ProviderHealthContext);
  if (!health) throw new Error("Provider health missing");
  return health;
}
const WEB = Platform.OS === "web";
/** The Mac to use until you save one in Settings; an empty address shows the Connect your Mac prompt. */
// Keep the normal backend preference available when reinstalling the original app.
const serverStorageKey = usesIroh
  ? "mondash:iroh:server"
  : Constants.expoConfig?.slug === "mondash-oss"
    ? "mondash:oss:server"
    : "mondash:server";
const NATIVE_SERVER = process.env.EXPO_PUBLIC_API_URL ? process.env.EXPO_PUBLIC_API_URL : "";
/** A saved section, with the stream's version of it when the stream saved it. */
const decodeSnapshot = Schema.decodeUnknownExit(
  Schema.Struct({ version: Schema.optional(Schema.String), section: SectionResponse }),
);
const cacheKey = (server: string, section: string) => `mondash:v1:${server}:${section}`;
const sectionKey = (server: string, section: string) => ["section", server, section];

export function Provider({ children }: { children: ReactNode }) {
  // On the web the Mac serves this app, so its API is on the same origin.
  const [server, updateServer] = useState(WEB && !usesIroh ? window.location.origin : NATIVE_SERVER);
  const macDesktop = WEB && isMacBrowser(navigator.userAgent, navigator.maxTouchPoints);
  const [claudeTarget, updateClaudeTarget] = useState<ClaudeTarget>(() => {
    try {
      return WEB ? readClaudeTarget(window.localStorage.getItem("mondash:claude-target")) : "claude-desktop";
    } catch {
      return "claude-desktop";
    }
  });
  const setClaudeTarget = useCallback(async (target: ClaudeTarget) => {
    await AsyncStorage.setItem("mondash:claude-target", target);
    updateClaudeTarget(target);
  }, []);
  const [ready, setReady] = useState(WEB && !usesIroh);
  const [startupError, setStartupError] = useState<string>();
  const [startupAttempt, retryStartup] = useState(0);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [browserRecovering, setBrowserRecovering] = useState(false);
  useEffect(() => {
    if (!WEB || usesIroh) return;
    const update = () => {
      const recovering = document.documentElement.dataset.mondashRecovering === "true";
      setBrowserRecovering(recovering);
      if (recovering) void client.cancelQueries();
    };
    window.addEventListener("mondash:recovery-change", update);
    update();
    return () => window.removeEventListener("mondash:recovery-change", update);
  }, []);
  const live = useRef(false);
  // Router hydration can restore its initial URL after the transport consumes the invitation.
  useEffect(() => {
    if (WEB && usesIroh && window.location.hash.startsWith("#mondash="))
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  }, [ready, server]);
  useEffect(() => {
    let mounted = true;
    if (!WEB || usesIroh)
      (usesIroh ? connectPairedMac() : AsyncStorage.getItem(serverStorageKey))
        .then((value) => {
          if (mounted && value) updateServer(normalizeServer(value));
        })
        .catch((error: unknown) => {
          if (mounted && WEB && usesIroh)
            setStartupError(error instanceof Error ? error.message : "Open Mondash on your Mac and try again.");
          else console.warn(error);
        })
        .finally(() => {
          if (mounted) setReady(true);
        });
    focusManager.setFocused(AppState.currentState === "active");
    const subscription = AppState.addEventListener("change", (state) => {
      focusManager.setFocused(state === "active");
      if (state === "background") void closeNativeRequests();
    });
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, [startupAttempt]);
  useEffect(() => {
    if (!ready || !server || browserRecovering) return;
    const diagnostics: { connection: Connection; sections: Record<string, number>; snapshots: number } = {
      connection: "connecting",
      sections: {},
      snapshots: 0,
    };
    const record = () => {
      void recordTransportDiagnostics(diagnostics).catch(console.warn);
    };
    const report = (next: Connection) => {
      live.current = next === "live";
      setConnection(next);
      if (next === "down" && WEB && !usesIroh) window.dispatchEvent(new Event("mondash:connection-lost"));
      diagnostics.connection = next;
      record();
    };
    let stop: (() => void) | undefined;
    let cancelled = false;
    // The saved sections go in first, so the stream sends only what changed since.
    const versions = new Map<string, string>();
    void Promise.all(
      SectionName.literals.map(async (name) => {
        const version = await hydrate(server, name);
        if (version) versions.set(name, version);
      }),
    ).then(() => {
      if (cancelled) return;
      stop = startSectionStream({
        server,
        fetch: fetchFor(server),
        appState: AppState,
        versions,
        onSection: (section, event) => {
          diagnostics.sections[section.section] = section.groups.reduce(
            (total, group) => total + group.cards.length,
            0,
          );
          diagnostics.snapshots++;
          record();
          client.setQueryData(sectionKey(server, section.section), section);
          AsyncStorage.setItem(cacheKey(server, section.section), event).catch(console.warn);
        },
        onTimes: ({ section, updatedAt, stale }) =>
          client.setQueryData<SectionResponse>(
            sectionKey(server, section),
            (cached) => cached && { ...cached, updatedAt, stale },
          ),
        // The section's own request then shows why it does not fit, where the stream could only drop it.
        onUnreadable: (section) => {
          console.warn(`The Mac streamed ${section ? `a ${section} event` : "an event"} this app cannot read`);
          void client.invalidateQueries({ queryKey: section ? sectionKey(server, section) : ["section", server] });
        },
        onConnection: report,
      });
    });
    return () => {
      cancelled = true;
      stop?.();
      report("connecting");
    };
  }, [ready, server, browserRecovering]);
  const setServer = useCallback(async (value: string) => {
    const normalized = normalizeServer(value);
    await AsyncStorage.setItem(serverStorageKey, normalized);
    updateServer(normalized);
  }, []);
  const refreshSection = useCallback(
    (section: SectionName) => {
      if (!live.current) void client.invalidateQueries({ queryKey: sectionKey(server, section) });
    },
    [server],
  );
  const settings = useMemo(
    () => ({ server, ready, setServer, refreshSection, macDesktop, claudeTarget, setClaudeTarget }),
    [server, ready, setServer, refreshSection, macDesktop, claudeTarget, setClaudeTarget],
  );
  if (WEB && usesIroh && (!ready || startupError))
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: "#0b0b0c",
          alignItems: "center",
          justifyContent: "center",
          padding: 28,
          gap: 18,
        }}
      >
        <Text accessibilityRole="header" style={{ color: "#f4f4f5", fontSize: 26, fontWeight: "600" }}>
          Mondash
        </Text>
        {startupError ? (
          <>
            <Text style={{ color: "#a1a1aa", textAlign: "center", maxWidth: 420 }}>{startupError}</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setStartupError(undefined);
                setReady(false);
                retryStartup((attempt) => attempt + 1);
              }}
              style={{ padding: 14, borderRadius: 12, backgroundColor: "#27272a" }}
            >
              <Text style={{ color: "#f4f4f5" }}>Try again</Text>
            </Pressable>
          </>
        ) : (
          <>
            <ActivityIndicator color="#a78bfa" />
            <Text style={{ color: "#a1a1aa" }}>Connecting to your Mac…</Text>
          </>
        )}
      </View>
    );
  return (
    <Settings value={settings}>
      <ConnectionContext value={connection}>
        <BrowserRecoveryContext value={browserRecovering}>
          <QueryClientProvider client={client}>
            <ProviderHealth>{children}</ProviderHealth>
          </QueryClientProvider>
        </BrowserRecoveryContext>
      </ConnectionContext>
    </Settings>
  );
}

export function useSettings() {
  const settings = use(Settings);
  if (!settings) throw new Error("Settings provider missing");
  return settings;
}

export const useConnection = () => use(ConnectionContext);

const hydrations = new Map<string, Promise<string | undefined>>();
const hydrated = new Set<string>();
/**
 * Reads a section's saved snapshot into the query cache, once per app run, and gives the stream's version of it.
 * Every screen and badge that shows the section shares this read, so opening one does not parse and decode the whole
 * snapshot again.
 */
function hydrate(server: string, section: SectionName) {
  const key = cacheKey(server, section);
  const known = hydrations.get(key);
  if (known) return known;
  const done = AsyncStorage.getItem(key)
    .then((value) => {
      if (!value) return undefined;
      // A snapshot from an older app version that no longer fits is ignored, not shown.
      const parsed = decodeSnapshot(JSON.parse(value));
      if (Exit.isFailure(parsed) || parsed.value.section.section !== section) return undefined;
      const queryKey = sectionKey(server, section);
      if (client.getQueryData(queryKey)) return undefined;
      client.setQueryData(queryKey, parsed.value.section, { updatedAt: 1 });
      return parsed.value.version;
    })
    .catch((failure: unknown) => {
      console.warn(failure);
      return undefined;
    })
    .finally(() => {
      hydrated.add(key);
    });
  hydrations.set(key, done);
  return done;
}

/**
 * A section from the cache, which the stream keeps current. Only while the stream is down does the screen you are
 * looking at ask the Mac itself, every 30 s and on return to the app; the others catch up when you open them.
 */
export function useSection<T = SectionResponse>(section: SectionName, select?: (data: SectionResponse) => T) {
  const { server, ready } = useSettings();
  const recovering = use(BrowserRecoveryContext);
  const down = useConnection() === "down";
  const key = cacheKey(server, section);
  const [hydratedKey, setHydratedKey] = useState("");
  const isHydrated = hydratedKey === key || hydrated.has(key);
  useEffect(() => {
    if (!ready || !server || hydrated.has(key)) return;
    let mounted = true;
    void hydrate(server, section).then(() => {
      if (mounted) setHydratedKey(key);
    });
    return () => {
      mounted = false;
    };
  }, [key, ready, server, section]);
  const polls = useIsFocused() && down && !recovering;
  const query = useQuery({
    queryKey: sectionKey(server, section),
    enabled: ready && Boolean(server) && isHydrated && !recovering,
    queryFn: async ({ signal }) => {
      const data = await loadSection(server, section, signal);
      await AsyncStorage.setItem(key, JSON.stringify({ section: data })).catch(console.warn);
      return data;
    },
    select,
    // Never stale while the stream can bring changes, so a mount or a return to the app does not ask the Mac again.
    // An invalidated section is stale either way.
    staleTime: down ? 20000 : Infinity,
    refetchInterval: polls ? 30000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: polls ? "always" : false,
  });
  // Read only while polling: reading a field makes this hook re-render on its every change.
  const dataUpdatedAt = polls ? query.dataUpdatedAt : 0;
  const { refetch } = query;
  useEffect(() => {
    if (dataUpdatedAt > 0 && Date.now() - dataUpdatedAt > 20_000) void refetch();
  }, [dataUpdatedAt, refetch]);
  return query;
}

const withRead = (data: SectionResponse, id: string, read: boolean): SectionResponse => ({
  ...data,
  groups: data.groups.map((group) => ({
    ...group,
    cards: group.cards.map((card) => (card.id === id ? { ...card, unread: !read } : card)),
  })),
});

/**
 * Marks an Inbox item read or unread. The row and the Inbox badge change at once; the change rolls back if the Mac
 * refuses, and the Inbox then follows the Mac.
 */
export function useMarkRead() {
  const { server, refreshSection } = useSettings();
  const inbox = { queryKey: sectionKey(server, "inbox") };
  return useMutation({
    mutationFn: ({ id, read }: { id: string; read: boolean }) => markFeedRead(server, id, read),
    onMutate: async ({ id, read }) => {
      await client.cancelQueries(inbox);
      const previous = client.getQueryData<SectionResponse>(inbox.queryKey);
      if (previous) client.setQueryData(inbox.queryKey, withRead(previous, id, read));
      return previous;
    },
    onError: (_failure, _variables, previous) => {
      if (previous) client.setQueryData(inbox.queryKey, previous);
    },
    onSettled: () => refreshSection("inbox"),
  });
}

/** Native archive requests change the list only after the provider confirms. */
export function useArchiveSession() {
  const { server } = useSettings();
  return useMutation({
    mutationFn: ({ tool, id, archived }: { tool: "claude" | "codex"; id: string; archived: boolean }) =>
      archiveSession(server, tool, id, archived),
    onSuccess: () => client.invalidateQueries({ queryKey: sectionKey(server, "sessions") }),
  });
}
