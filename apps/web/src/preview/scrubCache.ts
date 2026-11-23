/**
 * Scrub stand-ins (docs/features/preview.md "Instant scrub"): decoded frames kept around the paused playhead, and the timeline's filmstrip thumbnails.
 * While the exact frame decodes, the nearest of these is shown at once and then replaced. Stand-ins are a preview-only aid: export never reads them.
 */

interface Held { index: number; release(): void }

/** Decoded frames per media, LRU, bounded by bytes and by count (hardware decoders hand out few surfaces). A frame in use is pinned: eviction waits for `unpin`. */
export class FrameCache<T extends Held> {
  private media = new Map<string, Map<number, T>>();
  private order: { media: string; index: number }[] = []; // oldest first
  private bytes = 0;
  private refs = new Map<T, number>();
  private doomed = new Set<T>();

  constructor(private budgetBytes: number, private maxFrames: number, private sizeOf: (f: T) => number) {}

  get size(): number { return this.order.length; }
  get usedBytes(): number { return this.bytes; }
  has(media: string, index: number): boolean { return this.media.get(media)?.has(index) ?? false; }

  /** The cached frame, pinned (call `unpin` when drawn) and marked most recent. */
  get(media: string, index: number): T | undefined {
    const f = this.media.get(media)?.get(index);
    if (f) { this.touch(media, index); this.pin(f); }
    return f;
  }

  /** The cached frame of `media` closest to `index` (ties: the earlier one), pinned. */
  nearest(media: string, index: number): T | undefined {
    const m = this.media.get(media);
    if (!m || m.size === 0) return undefined;
    let best: T | undefined;
    let dist = Infinity;
    for (const [i, f] of m) {
      const d = Math.abs(i - index);
      if (d < dist || (d === dist && best && i < best.index)) { best = f; dist = d; }
    }
    if (best) this.pin(best);
    return best;
  }

  /** Take ownership of `f` (its `release` runs when it is evicted and unpinned). Returns it pinned. A frame already cached at that index is replaced. */
  put(media: string, f: T): T {
    const m = this.media.get(media) ?? new Map<number, T>();
    this.media.set(media, m);
    const old = m.get(f.index);
    if (old === f) { this.touch(media, f.index); this.pin(f); return f; }
    if (old) this.drop(media, f.index);
    m.set(f.index, f);
    this.order.push({ media, index: f.index });
    this.bytes += this.sizeOf(f);
    this.pin(f);
    this.evict();
    return f;
  }

  pin(f: T): void { this.refs.set(f, (this.refs.get(f) ?? 0) + 1); }

  unpin(f: T): void {
    const n = (this.refs.get(f) ?? 1) - 1;
    if (n > 0) { this.refs.set(f, n); return; }
    this.refs.delete(f);
    if (this.doomed.delete(f)) f.release();
  }

  /** Forget every frame of a media item (it left the project). */
  dropMedia(media: string): void {
    for (const index of [...(this.media.get(media)?.keys() ?? [])]) this.drop(media, index);
    this.media.delete(media);
  }

  clear(): void { for (const media of [...this.media.keys()]) this.dropMedia(media); }

  private touch(media: string, index: number): void {
    const at = this.order.findIndex((o) => o.media === media && o.index === index);
    if (at >= 0) this.order.push(...this.order.splice(at, 1));
  }

  private drop(media: string, index: number): void {
    const m = this.media.get(media);
    const f = m?.get(index);
    if (!m || !f) return;
    m.delete(index);
    this.bytes -= this.sizeOf(f);
    const at = this.order.findIndex((o) => o.media === media && o.index === index);
    if (at >= 0) this.order.splice(at, 1);
    if (this.refs.has(f)) this.doomed.add(f); else f.release();
  }

  private evict(): void {
    // Oldest unpinned first; a pinned frame is skipped (it goes when it is unpinned and evicted again).
    let i = 0;
    while ((this.order.length > this.maxFrames || this.bytes > this.budgetBytes) && i < this.order.length - 1) {
      const o = this.order[i]!;
      const f = this.media.get(o.media)?.get(o.index);
      if (f && this.refs.has(f)) { i++; continue; }
      this.drop(o.media, o.index);
    }
  }
}

export interface Thumb<B> { seconds: number; bitmap: B; width: number; height: number }

/** The filmstrip thumbnails the timeline has produced, per media, sorted by time; oldest dropped past `max`. */
export class ThumbStore<B extends { close?(): void }> {
  private byMedia = new Map<string, Thumb<B>[]>();
  private order: { media: string; seconds: number }[] = [];

  constructor(private max = 300) {}

  get size(): number { return this.order.length; }

  add(media: string, seconds: number, bitmap: B, width: number, height: number): void {
    const list = this.byMedia.get(media) ?? [];
    this.byMedia.set(media, list);
    const at = lowerBound(list, seconds);
    if (list[at]?.seconds === seconds) { list[at]!.bitmap.close?.(); list[at] = { seconds, bitmap, width, height }; return; }
    list.splice(at, 0, { seconds, bitmap, width, height });
    this.order.push({ media, seconds });
    while (this.order.length > this.max) { const o = this.order.shift()!; this.remove(o.media, o.seconds); }
  }

  /** The thumbnail closest in time to `seconds`. */
  nearest(media: string, seconds: number): Thumb<B> | undefined {
    const list = this.byMedia.get(media);
    if (!list || list.length === 0) return undefined;
    const at = lowerBound(list, seconds);
    const a = list[at - 1];
    const b = list[at];
    if (!a) return b;
    if (!b) return a;
    return seconds - a.seconds <= b.seconds - seconds ? a : b;
  }

  dropMedia(media: string): void {
    for (const t of this.byMedia.get(media) ?? []) t.bitmap.close?.();
    this.byMedia.delete(media);
    this.order = this.order.filter((o) => o.media !== media);
  }

  private remove(media: string, seconds: number): void {
    const list = this.byMedia.get(media);
    if (!list) return;
    const at = lowerBound(list, seconds);
    if (list[at]?.seconds === seconds) { list[at]!.bitmap.close?.(); list.splice(at, 1); }
  }
}

function lowerBound<B>(list: readonly Thumb<B>[], seconds: number): number {
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (list[mid]!.seconds < seconds) lo = mid + 1; else hi = mid; }
  return lo;
}
