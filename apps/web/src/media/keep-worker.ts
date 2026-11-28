/// <reference lib="webworker" />
/** Copies a picked file into the origin-private file system, off the UI thread (`docs/adr/0015-media-copies.md`). Works in every browser that has OPFS:
 *  `createSyncAccessHandle` exists in workers everywhere, while `createWritable` on the main thread does not (Safari). The sidecar `<key>.json` is written
 *  last, so a copy cut short (tab closed, disk full) never counts as complete. */
interface SyncHandle { write(b: Uint8Array, o: { at: number }): number; truncate(n: number): void; flush(): void; close(): void }
type Req = { id: number; key: string; file: File; meta: string };
type Res = { id: number; progress?: number; ok?: true; err?: string };

const post = (m: Res) => (self as unknown as Worker).postMessage(m);
const enc = new TextEncoder();

async function put(dir: FileSystemDirectoryHandle, name: string, write: (h: SyncHandle) => Promise<void>) {
  const fh = await dir.getFileHandle(name, { create: true });
  const h = await (fh as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle();
  try { h.truncate(0); await write(h); h.flush(); } finally { h.close(); }
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const { id, key, file, meta } = e.data;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("overcut-media", { create: true });
    await dir.removeEntry(`${key}.json`).catch(() => undefined);
    let last = 0;
    await put(dir, key, async (h) => {
      const reader = file.stream().getReader();
      let at = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        let off = 0;
        while (off < value.length) {
          const n = h.write(value.subarray(off), { at: at + off });
          if (n <= 0) throw new DOMException("disk full", "QuotaExceededError");
          off += n;
        }
        at += value.length;
        if (file.size > 0 && at - last > 8 * 1024 * 1024) { last = at; post({ id, progress: at / file.size }); }
      }
    });
    await put(dir, `${key}.json`, async (h) => { h.write(enc.encode(meta), { at: 0 }); });
    post({ id, ok: true });
  } catch (err) {
    try {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("overcut-media");
      await dir.removeEntry(key).catch(() => undefined);
      await dir.removeEntry(`${key}.json`).catch(() => undefined);
    } catch { /* nothing to clean */ }
    post({ id, err: err instanceof Error ? err.name : String(err) });
  }
};
