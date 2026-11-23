// App-shell cache so the installed app opens offline. Bump VERSION to drop old caches. Network-first for navigations, cache-first for hashed assets.
const VERSION = "v1";
// Visible network log (XT-06): report the files this worker itself loaded to the page (same channel as packages/engine-client/src/net-report.ts). Read-only; fetch is not wrapped.
try {
  const ch = new BroadcastChannel("overcut-network");
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) ch.postMessage({ url: e.name, bytes: e.transferSize || e.encodedBodySize || null, at: Math.round(performance.timeOrigin + e.startTime), initiator: "service-worker" });
  }).observe({ type: "resource", buffered: true });
} catch { /* optional */ }
const SHELL = ["/", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put("/", copy)); return r; }).catch(() => caches.match("/")));
    return;
  }
  // ignoreVary: the server sends `Vary: Origin`, and a module script asks with an Origin header the stored copy (warmed by main.tsx) lacks: without this the app would not start offline.
  e.respondWith(caches.match(req, { ignoreVary: true }).then((hit) => hit || fetch(req).then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); return r; })));
});
