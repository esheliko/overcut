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
// Share sheet (PM-02, docs/features/open-with.md): the manifest's share_target POSTs the shared files here. They are parked in a cache on this device
// (never sent anywhere), then the page is opened at /?shared=<id> and takes them. Keep the constants in step with apps/web/src/incoming.ts.
const SHARE_ACTION = "/share-target", SHARE_CACHE = "overcut-share";
async function takeShare(req) {
  try {
    const files = (await req.formData()).getAll("files").filter((f) => typeof f !== "string");
    if (files.length === 0) return Response.redirect("/", 303);
    const id = crypto.randomUUID(), cache = await caches.open(SHARE_CACHE);
    await Promise.all(files.map((f, i) => cache.put(`/__shared/${id}/${i}`, new Response(f, { headers: { "content-type": f.type || "application/octet-stream", "x-name": encodeURIComponent(f.name) } }))));
    return Response.redirect(`/?shared=${id}`, 303);
  } catch { return Response.redirect("/", 303); }
}
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (new URL(req.url).pathname === SHARE_ACTION && new URL(req.url).origin === self.location.origin) {
    e.respondWith(req.method === "POST" ? takeShare(req) : Response.redirect("/", 303));
    return;
  }
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put("/", copy)); return r; }).catch(() => caches.match("/")));
    return;
  }
  // ignoreVary: the server sends `Vary: Origin`, and a module script asks with an Origin header the stored copy (warmed by main.tsx) lacks: without this the app would not start offline.
  e.respondWith(caches.match(req, { ignoreVary: true }).then((hit) => hit || fetch(req).then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); return r; })));
});
