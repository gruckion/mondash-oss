import { Exit, Schema } from "effect";
import { SectionName, SectionResponse } from "@mondash/shared/contract";
import { takeEvents } from "./section-events";

/** Where the stream from the Mac stands. Only `down` makes screens ask the Mac themselves. */
export type Connection = "connecting" | "live" | "down";

const TimesEvent = Schema.Struct({
  times: Schema.Struct({
    section: SectionName,
    updatedAt: SectionResponse.fields.updatedAt,
    stale: SectionResponse.fields.stale,
  }),
});
export type SectionTimes = (typeof TimesEvent.Type)["times"];
const decodeSection = Schema.decodeUnknownExit(Schema.Struct({ version: Schema.String, section: SectionResponse }));
const decodeTimes = Schema.decodeUnknownExit(TimesEvent);

/** The parts of `expo/fetch` and React Native's `AppState` the stream uses, so a test can stand in for them. */
export type StreamFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ readonly ok: boolean; readonly status: number; readonly body: ReadableStream<Uint8Array> | null }>;
export type Foreground = {
  readonly currentState: string;
  addEventListener(type: "change", listener: (state: string) => void): { remove(): void };
};

const TIMING = { idleMs: 15_000, retryMs: 2000, maxRetryMs: 30_000 };

const nameIn = (value: unknown) =>
  typeof value === "object" && value !== null && "section" in value && typeof value.section === "string"
    ? value.section
    : undefined;

/**
 * Keeps the app's copy of every section in step with the Mac: the Mac sends a section each time it changes
 * (`/api/stream`), and only its times when nothing else changed. It connects while the app is in front, and reconnects
 * after a drop (2 s, doubling, at most 30 s), saying which versions it already has. `onSection` gets each section with
 * its event's JSON, for saving.
 */
export function startSectionStream({
  server,
  fetch,
  appState,
  versions: known,
  onSection,
  onTimes,
  onUnreadable,
  onConnection,
  timing = TIMING,
}: {
  server: string;
  fetch: StreamFetch;
  appState: Foreground;
  /** The versions the app already holds, so the Mac does not send them again. */
  versions: ReadonlyMap<string, string>;
  onSection: (section: SectionResponse, event: string) => void;
  onTimes: (times: SectionTimes) => void;
  /** An event that does not fit the contract; the section is undefined when even its name could not be read. */
  onUnreadable: (section: string | undefined) => void;
  onConnection: (connection: Connection) => void;
  timing?: typeof TIMING;
}) {
  const versions = new Map(known);
  let controller: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let stopped = false;

  const read = (text: string) => {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      onUnreadable(undefined);
      return;
    }
    if (typeof raw !== "object" || raw === null) return;
    if ("section" in raw) {
      const event = decodeSection(raw);
      if (Exit.isFailure(event)) return onUnreadable(nameIn(raw.section));
      versions.set(event.value.section.section, event.value.version);
      onSection(event.value.section, text);
    } else if ("times" in raw) {
      const event = decodeTimes(raw);
      if (Exit.isFailure(event)) return onUnreadable(nameIn(raw.times));
      onTimes(event.value.times);
    } else return;
    failures = 0;
  };

  const connect = () => {
    clearTimeout(retry);
    if (stopped || controller || appState.currentState !== "active") return;
    const aborter = new AbortController();
    controller = aborter;
    const have = [...versions].map(([name, version]) => `${name}:${version}`).join(",");
    // The Mac sends at least a keep-alive every 5 s, so this much silence is a connection that died without closing.
    let idle: ReturnType<typeof setTimeout> | undefined;
    const wake = () => {
      clearTimeout(idle);
      idle = setTimeout(() => aborter.abort(), timing.idleMs);
    };
    void (async () => {
      try {
        wake();
        const response = await fetch(`${server}/api/stream?have=${encodeURIComponent(have)}`, {
          headers: { accept: "text/event-stream" },
          signal: aborter.signal,
        });
        const reader = response.ok ? response.body?.getReader() : undefined;
        if (!reader) throw new Error(`The Mac answered ${response.status}`);
        onConnection("live");
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          wake();
          const { done, value } = await reader.read();
          if (done) break;
          const { data, rest } = takeEvents(buffer + decoder.decode(value, { stream: true }));
          buffer = rest;
          data.forEach(read);
        }
      } catch {
        // A drop, the idle timeout or the Mac being off: reconnect below.
      } finally {
        clearTimeout(idle);
        // A connection closed for the background, or after stop, says nothing about the Mac.
        if (controller === aborter && !stopped) {
          controller = undefined;
          onConnection("down");
          retry = setTimeout(connect, Math.min(timing.retryMs * 2 ** failures++, timing.maxRetryMs));
        }
      }
    })();
  };

  // iOS suspends the connection in the background; open a fresh one on return.
  const subscription = appState.addEventListener("change", (state) => {
    if (state === "active") return connect();
    controller?.abort();
    controller = undefined;
    onConnection("connecting");
  });
  connect();

  return () => {
    stopped = true;
    subscription.remove();
    clearTimeout(retry);
    controller?.abort();
  };
}
