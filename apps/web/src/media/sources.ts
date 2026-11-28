/**
 * Getting files from the user: picker, drag and drop, paste. A `Source` is a `File` (a handle to bytes on disk: never read whole)
 * plus, where the browser allows it (Chromium's File System Access API), a persistent handle so a reopened project finds the file again.
 */

import type { DesktopApi, MediaApi } from "@app/engine-client";
import { loadKept } from "./kept";

export interface Source {
  file: File;
  /** Present only with the File System Access API; stored so the file can be reopened without importing it again. */
  handle?: FileSystemFileHandle;
}

type PickerWindow = Window & {
  showOpenFilePicker?: (o: { multiple?: boolean; types?: { description: string; accept: Record<string, string[]> }[]; excludeAcceptAllOption?: boolean }) => Promise<FileSystemFileHandle[]>;
};
type HandleItem = DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> };

export const ACCEPT = "video/*,audio/*,image/*";

// ---- desktop app: native dialog and paths (M1-041). Set once the engine is up; undefined in a browser. ----
let desktop: DesktopApi | undefined;
export const setDesktop = (api: DesktopApi | undefined): void => { desktop = api; };
export const getDesktop = (): DesktopApi | undefined => desktop;
// The native decoder (`Engine.media` in the desktop app): the preview Worker cannot reach it, so the UI thread answers for it (preview/nativeMedia.ts).
let nativeMedia: MediaApi | undefined;
export const setNativeMedia = (m: MediaApi | undefined): void => { nativeMedia = m; };
export const getNativeMedia = (): MediaApi | undefined => nativeMedia;
/** The path of a file that stays on disk (picked or dropped in the desktop app), else undefined. */
export const pathOf = (f: File): string | undefined => (f as File & { path?: string }).path;

/** True where a persistent-handle picker exists (Chromium desktop). Phones use the plain input: it opens the camera roll. */
export const hasHandlePicker = (): boolean => desktop !== undefined || typeof window !== "undefined" && typeof (window as PickerWindow).showOpenFilePicker === "function" && !matchMedia("(pointer: coarse)").matches;

/** Opens the system picker. Resolves to nothing when the user cancels. */
export async function pickWithHandles(): Promise<Source[]> {
  if (desktop) return fromFileList(await desktop.pickMedia());
  try {
    const handles = await (window as PickerWindow).showOpenFilePicker!({
      multiple: true,
      types: [{ description: "Media", accept: { "video/*": [], "audio/*": [], "image/*": [] } }],
    });
    return await Promise.all(handles.map(async (handle) => ({ file: await handle.getFile(), handle })));
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return [];
    throw e;
  }
}

/** One file, for relinking: the handle picker where there is one, else a throwaway input. Resolves to `null` on cancel. */
export async function pickOne(): Promise<Source | null> {
  if (hasHandlePicker()) {
    const [one] = await pickWithHandles();
    return one ?? null;
  }
  return new Promise((ok) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ACCEPT;
    input.onchange = () => ok(input.files?.[0] ? { file: input.files[0] } : null);
    input.oncancel = () => ok(null);
    input.click();
  });
}

/** Several files, for relinking a whole reopened project: the handle picker where there is one, else a throwaway multi-file input. Empty on cancel. */
export async function pickMany(): Promise<Source[]> {
  if (hasHandlePicker()) return pickWithHandles();
  return new Promise((ok) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = ACCEPT;
    input.onchange = () => ok(Array.from(input.files ?? [], (file) => ({ file })));
    input.oncancel = () => ok([]);
    input.click();
  });
}

export const fromFileList = (files: FileList | File[] | null | undefined): Source[] => Array.from(files ?? [], (file) => ({ file }));

/** Files from a drop, with handles where the browser gives them. Folders are ignored. */
export async function fromDataTransfer(dt: DataTransfer): Promise<Source[]> {
  const out: Source[] = [];
  const items = Array.from(dt.items ?? []);
  if (items.length > 0 && items.every((i) => i.kind === "file")) {
    // Handles must be requested synchronously while the event is live, then awaited.
    const pending = items.map((i) => {
      const it = i as HandleItem;
      const handle = it.getAsFileSystemHandle ? it.getAsFileSystemHandle().catch(() => null) : Promise.resolve(null);
      return { file: it.getAsFile(), handle };
    });
    for (const p of pending) {
      const h = await p.handle;
      if (h && h.kind === "file") out.push({ file: await (h as FileSystemFileHandle).getFile(), handle: h as FileSystemFileHandle });
      else if (p.file) out.push({ file: p.file });
    }
    return out;
  }
  return fromFileList(dt.files);
}

/** True when a drag carries files from outside the page (not our own bin items). */
export const dragHasFiles = (dt: DataTransfer | null): boolean => !!dt && Array.from(dt.types ?? []).includes("Files");

/** Media dragged out of the bin onto the timeline carries its id under this type. */
export const BIN_DRAG_TYPE = "application/x-overcut-media";

// ---- persistent handles (IndexedDB) -------------------------------------------------------------------------------------------

const DB = "overcut-media";
const STORE = "handles";

function db(): Promise<IDBDatabase> {
  return new Promise((ok, bad) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => bad(r.error);
  });
}

/** Remembers a file handle under the media's `uri`. Failure is silent: the file simply needs relinking after a reload. */
export async function saveHandle(uri: string, handle: FileSystemFileHandle): Promise<void> {
  try {
    const d = await db();
    await new Promise<void>((ok, bad) => {
      const tx = d.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(handle, uri);
      handleCache.set(uri, handle);
      tx.oncomplete = () => ok();
      tx.onerror = () => bad(tx.error);
    });
    d.close();
  } catch {
    /* private mode, quota, no IndexedDB: relink instead */
  }
}

type Perm = { queryPermission(o: { mode: "read" }): Promise<PermissionState>; requestPermission(o: { mode: "read" }): Promise<PermissionState> };
/** Handles read from storage, by uri: "Allow access" must start every `requestPermission` inside one click, so it cannot wait for IndexedDB reads. */
const handleCache = new Map<string, FileSystemFileHandle>();

async function readHandle(uri: string): Promise<FileSystemFileHandle | undefined> {
  const cached = handleCache.get(uri);
  if (cached) return cached;
  const d = await db();
  const handle = await new Promise<FileSystemFileHandle | undefined>((ok, bad) => {
    const r = d.transaction(STORE).objectStore(STORE).get(uri);
    r.onsuccess = () => ok(r.result as FileSystemFileHandle | undefined);
    r.onerror = () => bad(r.error);
  });
  d.close();
  if (handle) handleCache.set(uri, handle);
  return handle;
}

/**
 * What a reopened file needs: `granted` (readable now), `prompt` (the browser keeps the handle but asks again after a reload: one "Allow access"
 * click fixes it, the file is NOT missing), or `missing` (no handle, or the file cannot be read).
 */
export type HandleState = "granted" | "prompt" | "missing";
export async function handleState(uri: string): Promise<HandleState> {
  if (uri.startsWith("path:")) return "granted"; // desktop: read where it lies; `loadHandle` says whether it still is there
  if (uri.startsWith("kept:")) return (await loadKept(uri)) ? "granted" : "missing"; // our own copy in the origin-private file system: no permission to ask for
  try {
    const handle = await readHandle(uri);
    if (!handle) return "missing";
    const state = await (handle as unknown as Perm).queryPermission({ mode: "read" });
    return state === "granted" ? "granted" : "prompt";
  } catch {
    return "missing";
  }
}

/** Asks permission for every uri at once. Call it straight from the click (before any await): all prompts start inside the one user gesture. Resolves to the uris that were granted. */
export function allowAll(uris: readonly string[]): Promise<string[]> {
  const asks = uris.map(async (uri) => {
    const handle = handleCache.get(uri);
    if (!handle) return null;
    try { return (await (handle as unknown as Perm).requestPermission({ mode: "read" })) === "granted" ? uri : null; } catch { return null; }
  });
  return Promise.all(asks).then((r) => r.filter((x): x is string => x !== null));
}

/**
 * The file behind a stored `uri`, or `null` (never stored, or permission was not granted: the caller shows "relink").
 * `request` asks the user for permission, which must happen from a click; without it only an existing grant counts.
 */
export async function loadHandle(uri: string, request = false, name?: string): Promise<File | null> {
  if (uri.startsWith("kept:")) return loadKept(uri, name);
  if (uri.startsWith("path:")) return desktop ? desktop.fileAt(uri.slice(5)) : null; // desktop: the file is read where it lies
  try {
    const handle = await readHandle(uri);
    if (!handle) return null;
    const p = handle as unknown as Perm;
    let state = await p.queryPermission({ mode: "read" });
    if (state === "prompt" && request) state = await p.requestPermission({ mode: "read" });
    return state === "granted" ? await handle.getFile() : null;
  } catch {
    return null;
  }
}
