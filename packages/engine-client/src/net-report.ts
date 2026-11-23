/**
 * Visible network log (XT-06): a Worker or the service worker reports the files it loaded on a BroadcastChannel the page listens to
 * (`apps/web/src/privacy/networkLog.ts`). Uses PerformanceObserver (read-only resource timing): `fetch` is never wrapped, behaviour is unchanged.
 * Best effort: missing APIs mean nothing is reported, never an error.
 */
export const NETWORK_CHANNEL = "overcut-network";

export type NetReport = { url: string; bytes: number | null; at: number; initiator: "worker" | "service-worker" };

export function reportWorkerNetwork(initiator: NetReport["initiator"] = "worker"): void {
  try {
    if (typeof PerformanceObserver === "undefined" || typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(NETWORK_CHANNEL);
    const origin = performance.timeOrigin;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceResourceTiming[]) {
        const bytes = e.transferSize || e.encodedBodySize || null;
        ch.postMessage({ url: e.name, bytes, at: Math.round(origin + e.startTime), initiator } satisfies NetReport);
      }
    }).observe({ type: "resource", buffered: true });
  } catch { /* the log is a courtesy; it must never break a Worker */ }
}
