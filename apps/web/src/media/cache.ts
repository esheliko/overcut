/** Size-limited blob cache for derived media data (peaks, thumbnails), keyed by media fingerprint.
 *  Backends: OPFS (browsers, and the webview inside the Tauri shells) or memory (tests, browsers without OPFS).
 *  Least-recently-used entries go first when the total passes the limit. Everything here is derived data: losing it only costs a recompute. */

export interface BlobStore {
  /** Every entry with its size and last-modified time (ms). */
  list(): Promise<{ key: string; size: number; modified: number }[]>;
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemoryStore implements BlobStore {
  private map = new Map<string, { bytes: Uint8Array; modified: number }>();
  async list() { return [...this.map].map(([key, v]) => ({ key, size: v.bytes.length, modified: v.modified })); }
  async get(key: string) { return this.map.get(key)?.bytes ?? null; }
  async put(key: string, bytes: Uint8Array) { this.map.set(key, { bytes, modified: Date.now() }); }
  async delete(key: string) { this.map.delete(key); }
}

/** Origin-private file system: `<root>/overcut-cache/<key with "/" replaced by "~">`. */
export class OpfsStore implements BlobStore {
  private dir: Promise<FileSystemDirectoryHandle>;
  constructor(name = "overcut-cache") {
    this.dir = navigator.storage.getDirectory().then((r) => r.getDirectoryHandle(name, { create: true }));
  }
  private static file = (key: string) => key.replace(/\//g, "~");
  private static key = (file: string) => file.replace(/~/g, "/");
  async list() {
    const out: { key: string; size: number; modified: number }[] = [];
    const dir = (await this.dir) as FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> };
    for await (const h of dir.values()) {
      if (h.kind !== "file") continue;
      const f = await (h as FileSystemFileHandle).getFile();
      out.push({ key: OpfsStore.key(h.name), size: f.size, modified: f.lastModified });
    }
    return out;
  }
  async get(key: string) {
    try {
      const h = await (await this.dir).getFileHandle(OpfsStore.file(key));
      return new Uint8Array(await (await h.getFile()).arrayBuffer());
    } catch { return null; }
  }
  async put(key: string, bytes: Uint8Array) {
    const h = await (await this.dir).getFileHandle(OpfsStore.file(key), { create: true });
    const w = await h.createWritable();
    await w.write(bytes as unknown as BufferSource);
    await w.close();
  }
  async delete(key: string) {
    try { await (await this.dir).removeEntry(OpfsStore.file(key)); } catch { /* already gone */ }
  }
}

/** OPFS when the browser has it, otherwise memory. */
export function defaultStore(): BlobStore {
  try {
    if (typeof navigator !== "undefined" && navigator.storage && typeof navigator.storage.getDirectory === "function") return new OpfsStore();
  } catch { /* fall through */ }
  return new MemoryStore();
}

export const DEFAULT_LIMIT_BYTES = 256 * 1024 * 1024;

/** LRU wrapper with a byte limit. The index lives in memory (built from `list()` on first use). Failures of the store never throw: a cache miss is the fallback. */
export class MediaCache {
  private index = new Map<string, { size: number; used: number }>();
  private total = 0;
  private ready: Promise<void>;
  private clock = 0;
  constructor(private store: BlobStore, private limit = DEFAULT_LIMIT_BYTES) {
    this.ready = store.list().then((all) => {
      // Oldest first so recency order survives a restart (file modification time stands in for last use).
      for (const e of all.sort((a, b) => a.modified - b.modified)) { this.index.set(e.key, { size: e.size, used: ++this.clock }); this.total += e.size; }
    }).catch(() => undefined);
  }
  get bytes() { return this.total; }
  get size() { return this.index.size; }
  setLimit(limit: number) { this.limit = limit; return this.evict(); }

  async get(key: string): Promise<Uint8Array | null> {
    await this.ready;
    const e = this.index.get(key);
    if (!e) return null;
    try {
      const b = await this.store.get(key);
      if (b) { e.used = ++this.clock; return b; }
    } catch { /* treat as missing */ }
    this.drop(key);
    return null;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    await this.ready;
    if (bytes.length > this.limit) return; // never worth evicting everything for one oversized entry
    try { await this.store.put(key, bytes); } catch { return; }
    this.drop(key);
    this.index.set(key, { size: bytes.length, used: ++this.clock });
    this.total += bytes.length;
    await this.evict();
  }

  async has(key: string): Promise<boolean> { await this.ready; return this.index.has(key); }
  async remove(key: string): Promise<void> { await this.ready; this.drop(key); try { await this.store.delete(key); } catch { /* ignore */ } }

  private drop(key: string) {
    const e = this.index.get(key);
    if (e) { this.total -= e.size; this.index.delete(key); }
  }
  private async evict() {
    await this.ready;
    if (this.total <= this.limit) return;
    const oldest = [...this.index].sort((a, b) => a[1].used - b[1].used);
    for (const [key] of oldest) {
      if (this.total <= this.limit) break;
      this.drop(key);
      try { await this.store.delete(key); } catch { /* ignore */ }
    }
  }
}

/** Cache key part for a media file: its content hash when the host computed one, else its locator. Safe for file names. */
export function fingerprint(media: { hash?: string | null; uri: string }): string {
  const raw = media.hash ? `h-${media.hash}` : `u-${media.uri}`;
  return raw.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}
