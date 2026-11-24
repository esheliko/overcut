/**
 * Files that reach OverCut from outside the window (PM-02, `docs/features/open-with.md`): the system "Open with" (installed PWA file handling,
 * desktop file associations and launch arguments), the Android / ChromeOS share sheet (web share target), and the desktop shell's "second launch".
 * All of them end in the same two doors as the picker: `.overcut` opens the project, anything else goes to the media bin.
 * Nothing here touches the network: shared files travel page-to-worker-to-page through the Cache API on this device.
 */
import type { DesktopApi } from "@app/engine-client";
import { useCallback, useEffect, useRef } from "react";
import type { Source } from "./media/sources";
import { PROJECT_EXT } from "./projectName";

/** The path the manifest's `share_target` posts to. `public/sw.js` answers it; keep both in step (`tests/unit/incoming.test.ts`). */
export const SHARE_ACTION = "/share-target";
/** Cache the worker parks shared files in until the page takes them (`public/sw.js`). */
export const SHARE_CACHE = "overcut-share";
const SHARE_PREFIX = "/__shared/";
const SHARE_ID = /^[A-Za-z0-9-]{8,64}$/;

export const isProjectFile = (f: { name: string }): boolean => f.name.toLowerCase().endsWith(PROJECT_EXT);

export interface Routed {
  /** The `.overcut` project to open, if any arrived (the first one). */
  project: Source | null;
  /** Everything else, in order: handed to the media bin, which says why a file it cannot use is skipped. */
  media: Source[];
}

/**
 * A project file wins: opening it replaces the project, so media that came with it would land in the wrong one. The media are then
 * dropped (the person can share them again), which is the reversible choice (nothing is imported into a project about to be swapped out).
 */
export function routeIncoming(sources: readonly Source[]): Routed {
  const project = sources.find((s) => isProjectFile(s.file)) ?? null;
  return project ? { project, media: [] } : { project: null, media: [...sources] };
}

/** The `?shared=<id>` the service worker redirects to after a share, or null for anything that is not one of its ids. */
export function sharedIdFromSearch(search: string): string | null {
  const id = new URLSearchParams(search).get("shared");
  return id && SHARE_ID.test(id) ? id : null;
}

type CacheLike = Pick<Cache, "keys" | "match" | "delete">;
export type CachesLike = { open(name: string): Promise<CacheLike> };

/** Takes (reads, then deletes) the files the service worker parked for `id`, in the order they were shared. Empty when there is no Cache API. */
export async function takeShared(id: string, store: CachesLike | undefined = typeof caches === "undefined" ? undefined : caches): Promise<Source[]> {
  if (!store || !SHARE_ID.test(id)) return [];
  const cache = await store.open(SHARE_CACHE);
  const prefix = `${SHARE_PREFIX}${id}/`;
  const keys = (await cache.keys()).filter((r) => new URL(r.url).pathname.startsWith(prefix));
  keys.sort((a, b) => Number(new URL(a.url).pathname.slice(prefix.length)) - Number(new URL(b.url).pathname.slice(prefix.length)));
  const out: Source[] = [];
  for (const key of keys) {
    const res = await cache.match(key);
    if (res) {
      const name = decodeURIComponent(res.headers.get("x-name") ?? "") || "shared";
      out.push({ file: new File([await res.blob()], name, { type: res.headers.get("content-type") ?? "" }) });
    }
    await cache.delete(key);
  }
  return out;
}

type LaunchParams = { files: readonly FileSystemFileHandle[] };
type LaunchWindow = Window & { launchQueue?: { setConsumer(c: (p: LaunchParams) => void | Promise<void>): void } };

const consumedShares = new Set<string>(); // React strict mode runs effects twice in dev: take each share once

export interface IncomingOptions {
  /** True once a file can be acted on (engine and project session are open). Files that arrive earlier wait. */
  ready: boolean;
  desktop?: DesktopApi;
  onMedia(sources: Source[]): void;
  onProject(source: Source): void;
}

/** Subscribes to every way a file can arrive and routes it with `routeIncoming`. Browsers or shells without a given door simply never fire it. */
export function useIncoming(opts: IncomingOptions): void {
  const queue = useRef<Source[]>([]);
  const latest = useRef(opts);
  latest.current = opts;

  const flush = useCallback(() => {
    if (!latest.current.ready || queue.current.length === 0) return;
    const routed = routeIncoming(queue.current.splice(0));
    if (routed.project) latest.current.onProject(routed.project);
    else if (routed.media.length > 0) latest.current.onMedia(routed.media);
  }, []);
  const arrive = useCallback((sources: Source[]) => { queue.current.push(...sources); flush(); }, [flush]);

  useEffect(() => { if (opts.ready) flush(); }, [opts.ready, flush]);

  useEffect(() => {
    // Share sheet: the worker redirected to `/?shared=<id>`.
    const id = sharedIdFromSearch(location.search);
    if (id && !consumedShares.has(id)) {
      consumedShares.add(id);
      const url = new URL(location.href);
      url.searchParams.delete("shared");
      history.replaceState(history.state, "", url.pathname + url.search + url.hash);
      void takeShared(id).then(arrive).catch(() => undefined);
    }
    // Installed PWA "Open with" (Chromium `file_handlers`). Feature-detected: absent elsewhere.
    (window as LaunchWindow).launchQueue?.setConsumer(async (p) => {
      const sources = await Promise.all(p.files.map(async (handle) => ({ file: await handle.getFile(), handle })));
      arrive(sources);
    });
  }, [arrive]);

  const desktop = opts.desktop;
  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    let off: (() => void) | undefined;
    const drain = () => void desktop.launchFiles().then((files) => files.length > 0 && arrive(files.map((file) => ({ file })))).catch(() => undefined);
    drain(); // files the app was started with (Windows / Linux arguments, macOS "Open with")
    void desktop.onOpen(drain).then((un) => (alive ? (off = un) : un())).catch(() => undefined); // another launch while running
    return () => { alive = false; off?.(); };
  }, [desktop, arrive]);
}
