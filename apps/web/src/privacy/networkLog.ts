/**
 * The visible network log (XT-06). Lists every request the app made this session so the user can see for themselves that nothing leaves the device.
 *
 * Sources, none of which wraps `fetch` or changes behaviour:
 *  - the page: `PerformanceObserver` on resource entries (`startNetworkCapture`);
 *  - Workers and the service worker: they report their own resource entries on a BroadcastChannel (`reportWorkerNetwork`, packages/engine-client);
 *  - the desktop app: Rust-side downloads call `recordNetworkEvent` (below) when the user starts one.
 */
import type { NetReport } from "@app/engine-client";

/** Same name as `NETWORK_CHANNEL` in packages/engine-client/src/net-report.ts (a value import would pull the whole client into the unit test). */
const NETWORK_CHANNEL = "overcut-network";

export type Initiator = "app-asset" | "worker" | "service-worker" | "user-download";
export type NetworkEvent = { id: number; at: number; url: string; bytes: number | null; initiator: Initiator };
export type NetworkEventInput = { url: string; bytes?: number | null; at?: number; initiator: Initiator };

export type NetworkLog = {
  record(e: NetworkEventInput): void;
  list(): readonly NetworkEvent[];
  subscribe(l: () => void): () => void;
};

/** An in-memory, capped list. `list()` returns the same array until something is recorded (what `useSyncExternalStore` needs). */
export function createNetworkLog(cap = 500): NetworkLog {
  let events: readonly NetworkEvent[] = [];
  let next = 1;
  const listeners = new Set<() => void>();
  const seen = new Set<string>();
  return {
    record(e) {
      const at = e.at ?? Date.now();
      const key = `${e.initiator}|${e.url}|${at}`;
      if (e.initiator !== "user-download" && seen.has(key)) return; // buffered observers can replay an entry
      seen.add(key);
      events = [...events, { id: next++, at, url: e.url, bytes: e.bytes ?? null, initiator: e.initiator }].slice(-cap);
      listeners.forEach((l) => l());
    },
    list: () => events,
    subscribe(l) { listeners.add(l); return () => void listeners.delete(l); },
  };
}

export const networkLog = createNetworkLog();

/**
 * For code that makes a network call the browser cannot see (the desktop app's native downloader, e.g. the optional OpenH264 codec, M1-041).
 * Call it when the user-started download begins or finishes: `recordNetworkEvent({ url, bytes, initiator: "user-download" })`.
 */
/** Host of the desktop-only, user-started OpenH264 download (mirrors `HOST` in apps/desktop/native-media/src/openh264.rs and config/network-allowlist.json). */
export const OPENH264_HOST_URL = "https://ciscobinary.openh264.org/";

export const recordNetworkEvent = (e: NetworkEventInput): void => networkLog.record(e);

export type Summary = { total: number; bytes: number; outside: string[]; downloads: number };

/** What the log says in one glance: how many requests, and which hosts other than the app's own were contacted. */
export function summarize(events: readonly NetworkEvent[], ownHost: string): Summary {
  const outside = new Set<string>();
  let bytes = 0;
  let downloads = 0;
  for (const e of events) {
    bytes += e.bytes ?? 0;
    if (e.initiator === "user-download") downloads++;
    const host = hostOf(e.url);
    if (host && host !== ownHost) outside.add(host);
  }
  return { total: events.length, bytes, outside: [...outside].sort(), downloads };
}

/** The host of a network URL; `data:` / `blob:` never leave the device and have none. */
export function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return /^(https?|wss?):$/.test(u.protocol) ? u.host : null;
  } catch { return null; }
}

let started = false;
/** Start collecting (once, before first render): the page's own resource entries, plus reports from Workers and the service worker. */
export function startNetworkCapture(log: NetworkLog = networkLog): void {
  if (started || typeof PerformanceObserver === "undefined") return;
  started = true;
  try {
    const origin = performance.timeOrigin;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceResourceTiming[]) {
        if (!hostOf(e.name)) continue;
        log.record({ url: e.name, bytes: e.transferSize || e.encodedBodySize || null, at: Math.round(origin + e.startTime), initiator: "app-asset" });
      }
    }).observe({ type: "resource", buffered: true });
    if (typeof BroadcastChannel !== "undefined") {
      new BroadcastChannel(NETWORK_CHANNEL).onmessage = (m: MessageEvent<NetReport>) => {
        const r = m.data;
        if (r && typeof r.url === "string" && hostOf(r.url)) log.record({ url: r.url, bytes: r.bytes, at: r.at, initiator: r.initiator });
      };
    }
  } catch { /* the log is a courtesy; never take the app down */ }
}
