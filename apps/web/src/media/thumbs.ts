/** Filmstrip thumbnails: small WebP frames at a few zoom-dependent intervals, generated lazily for what is on screen,
 *  cached on disk by media fingerprint (`thumb/<fp>/<interval>/<k>.webp`) and in memory as ImageBitmaps. */
import type { MediaRef } from "@app/engine-client";
import type { MediaCache } from "./cache";
import type { MediaHost } from "./host";
import { emitThumb } from "./thumbBus";

export const THUMB_W = 160;
export const THUMB_H = 90;
/** Seconds between thumbnails; one of these is picked so a slot is at least one thumbnail wide (never more than 2x). */
export const INTERVALS = [0.25, 0.5, 1, 2, 3, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 2400] as const;

/** Index into INTERVALS for the zoom `pps` (pixels per second) and the on-screen thumbnail width in CSS pixels. */
export function intervalFor(pps: number, thumbWidthPx: number): number {
  for (let i = 0; i < INTERVALS.length; i++) if (INTERVALS[i]! * pps >= thumbWidthPx) return i;
  return INTERVALS.length - 1;
}

const MAX_BITMAPS = 600;
const MAX_PARALLEL = 3;
const MAX_QUEUE = 48;

export class ThumbService {
  /** Insertion order = recency (re-inserted on use would allocate; eviction by age is enough here). */
  private bitmaps = new Map<string, Map<number, ImageBitmap>>();
  private count = 0;
  private pending = new Set<string>();
  private queue: (() => Promise<void>)[] = [];
  private active = 0;
  onChange: () => void = () => undefined;
  readonly stats = { generated: 0, fromCache: 0 };

  constructor(private host: MediaHost, private cache: MediaCache) {}

  /** The bitmap for slot `k` of interval index `iv` (time k * INTERVALS[iv]), or null while it loads (and schedules it). */
  get(media: MediaRef, fp: string, iv: number, k: number): ImageBitmap | null {
    const key = iv * 1e7 + k;
    const m = this.bitmaps.get(fp);
    const hit = m?.get(key);
    if (hit) return hit;
    const id = `${fp}|${key}`;
    if (!this.pending.has(id)) {
      this.pending.add(id);
      this.queue.push(() => this.load(media, fp, iv, k, key, id));
      if (this.queue.length > MAX_QUEUE) { this.queue.shift(); }
      void this.drain();
    }
    return null;
  }

  private async drain() {
    while (this.active < MAX_PARALLEL && this.queue.length) {
      const job = this.queue.pop()!; // newest first
      this.active++;
      void job().finally(() => { this.active--; void this.drain(); });
    }
  }

  private async load(media: MediaRef, fp: string, iv: number, k: number, key: number, id: string) {
    try {
      const blobKey = `thumb/${fp}/${iv}/${k}.webp`;
      let bmp: ImageBitmap | null = null;
      const stored = await this.cache.get(blobKey);
      if (stored) {
        try { bmp = await createImageBitmap(new Blob([stored as unknown as BlobPart], { type: "image/webp" })); this.stats.fromCache++; } catch { bmp = null; }
      }
      if (!bmp) {
        bmp = await this.host.thumbnail(media, k * INTERVALS[iv]!, THUMB_W, THUMB_H);
        this.stats.generated++;
        void this.store(blobKey, bmp);
      }
      let m = this.bitmaps.get(fp);
      if (!m) this.bitmaps.set(fp, (m = new Map()));
      m.set(key, bmp);
      if (++this.count > MAX_BITMAPS) this.evict(fp);
      emitThumb(media.id, k * INTERVALS[iv]!, bmp);
      this.onChange();
    } catch { /* a frame that cannot be produced stays a placeholder */ }
    finally { this.pending.delete(id); }
  }

  private async store(blobKey: string, bmp: ImageBitmap) {
    try {
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      c.getContext("2d")!.drawImage(bmp, 0, 0);
      const blob = await c.convertToBlob({ type: "image/webp", quality: 0.72 });
      await this.cache.put(blobKey, new Uint8Array(await blob.arrayBuffer()));
    } catch { /* cache is optional */ }
  }

  private evict(keep: string) {
    for (const [fp, m] of this.bitmaps) {
      if (fp === keep && this.bitmaps.size > 1) continue;
      for (const [k, b] of m) { b.close(); m.delete(k); this.count--; if (this.count <= MAX_BITMAPS * 0.8) return; }
    }
  }
}
