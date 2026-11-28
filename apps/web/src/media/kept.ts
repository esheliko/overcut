/**
 * Copies of imported files kept on the device (OPFS), for browsers that cannot keep a file handle (Safari, Firefox, phones): a reload finds the media
 * again with no relink. `docs/adr/0015-media-copies.md`. Everything fails soft: where OPFS or a Worker is missing, or the budget is spent, the file is
 * simply not kept and today's relink flow applies. Nothing here touches the network.
 */
import { fitsBudget, keepLimit, keptKey, unusedKeys, type KeptEntry, type KeptMeta } from "./keep-plan";

const DIR = "overcut-media";

let owner = "";
/** The open project's id: written next to each new copy, so "Remove unused media copies" knows whose it is. */
export const setKeptOwner = (id: string | null): void => { owner = id ?? ""; };
export const getKeptOwner = (): string | null => owner || null;

export const keptSupported = (): boolean =>
  typeof navigator !== "undefined" && !!navigator.storage && typeof navigator.storage.getDirectory === "function" && typeof Worker !== "undefined";

async function dir(create = false): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create });
  } catch { return null; }
}

/** Every complete copy: its file and its sidecar agree on the size. A copy cut short has no sidecar and is not listed. */
export async function listKept(): Promise<KeptEntry[]> {
  const d = (await dir()) as (FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> }) | null;
  if (!d) return [];
  const out: KeptEntry[] = [];
  try {
    for await (const h of d.values()) {
      if (h.kind !== "file" || h.name.endsWith(".json")) continue;
      try {
        const size = (await (h as FileSystemFileHandle).getFile()).size;
        const meta = JSON.parse(await (await (await d.getFileHandle(`${h.name}.json`)).getFile()).text()) as KeptMeta;
        if (meta.size === size) out.push({ key: h.name, size, meta });
      } catch { /* incomplete: skipped (and removed by the next "free space") */ }
    }
  } catch { /* unreadable: nothing is listed */ }
  return out;
}

export interface KeptUse { used: number; limit: number; count: number; persisted: boolean }
export async function keptUse(): Promise<KeptUse> {
  const entries = await listKept();
  let quota: number | null = null;
  let persisted = false;
  try { quota = (await navigator.storage.estimate()).quota ?? null; persisted = (await navigator.storage.persisted?.()) ?? false; } catch { /* unknown */ }
  return { used: entries.reduce((n, e) => n + e.size, 0), limit: keepLimit(quota), count: entries.length, persisted };
}

/** Would a file of this size be kept now? (Room in the budget and a place to put it.) */
export async function canKeep(size: number): Promise<boolean> {
  if (!keptSupported()) return false;
  try {
    const u = await keptUse();
    const quota = (await navigator.storage.estimate()).quota ?? null;
    return fitsBudget(size, { used: u.used, quota });
  } catch { return false; }
}

/** The kept file for a `kept:` uri, renamed to the media's name; `null` when it is gone or incomplete. */
export async function loadKept(uri: string, name?: string): Promise<File | null> {
  const key = keptKey(uri);
  if (!key) return null;
  const d = await dir();
  if (!d) return null;
  try {
    const f = await (await d.getFileHandle(key)).getFile();
    const meta = JSON.parse(await (await (await d.getFileHandle(`${key}.json`)).getFile()).text()) as KeptMeta;
    if (meta.size !== f.size) return null;
    return new File([f], name ?? meta.name, { type: f.type, lastModified: f.lastModified });
  } catch { return null; }
}

let worker: Worker | null = null;
let next = 1;
const waiting = new Map<number, { done(ok: boolean): void; progress?(p: number): void }>();
function pool(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./keep-worker.ts", import.meta.url), { type: "module", name: "keep-media" });
  w.onmessage = (e: MessageEvent<{ id: number; progress?: number; ok?: true; err?: string }>) => {
    const p = waiting.get(e.data.id);
    if (!p) return;
    if (e.data.progress !== undefined) return p.progress?.(e.data.progress);
    waiting.delete(e.data.id);
    p.done(e.data.ok === true);
  };
  w.onerror = () => { for (const p of waiting.values()) p.done(false); waiting.clear(); worker = null; };
  return (worker = w);
}

/** Copies `file` into storage under `key` (streamed in a Worker). Resolves to whether the copy is complete. `onProgress` gets 0..1 for big files. */
export function keepCopy(file: File, key: string, onProgress?: (p: number) => void): Promise<boolean> {
  if (!keptSupported()) return Promise.resolve(false);
  return new Promise((done) => {
    const id = next++;
    waiting.set(id, { done, progress: onProgress });
    const meta: KeptMeta = { name: file.name, size: file.size, owner };
    try { pool().postMessage({ id, key, file, meta: JSON.stringify(meta) }); } catch { waiting.delete(id); done(false); }
  });
}

/** Asks the browser not to evict the site's storage (the copies and the projects). Best effort; the answer is shown in the bin. */
export const askPersistent = (): Promise<boolean> => navigator.storage?.persist?.().catch(() => false) ?? Promise.resolve(false);

export async function removeKept(keys: readonly string[]): Promise<void> {
  const d = await dir();
  if (!d) return;
  for (const k of keys) {
    await d.removeEntry(k).catch(() => undefined);
    await d.removeEntry(`${k}.json`).catch(() => undefined);
  }
}

/** "Remove unused media copies": copies the open project does not use (and copies of deleted projects). Returns how many bytes were freed. */
export async function freeUnused(inUse: ReadonlySet<string>, projectIds: ReadonlySet<string>, current: string | null): Promise<number> {
  const entries = await listKept();
  const gone = new Set(unusedKeys(entries, inUse, projectIds, current));
  await removeKept([...gone]);
  return entries.filter((e) => gone.has(e.key)).reduce((n, e) => n + e.size, 0);
}
