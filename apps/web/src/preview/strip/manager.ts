/**
 * The scrub strip manager (preview Worker): decides per clip whether it needs a strip (`policy.needsStrip`: GOP length from the demuxer index,
 * device tier, measured seek times), builds it in the background one clip at a time, serves stand-in pictures to the player, and reports progress.
 * Fail-soft everywhere: any failure means no strip (the exact decode and the other stand-ins still work).
 */
import type { MediaHandle } from "@app/engine-client";
import { MediaCache, MemoryStore, OpfsStore, type BlobStore } from "../../media/cache";
import { buildStrip } from "./builder";
import { deviceTier, needsStrip, planStrip, type Decision, type StripSpec, type Tier } from "./policy";
import { StripReader, type StripPic } from "./reader";
import { baseKey, loadManifest, STRIP_CAP_DEFAULT, type Manifest } from "./store";

interface Entry {
  id: string;
  handle: MediaHandle;
  fp: string;
  spec: StripSpec;
  base: string;
  frames: number;
  seeks: number[];
  manifest?: Manifest;
  reader?: StripReader;
  state: "idle" | "queued" | "building" | "ready" | "skipped";
  decision?: Decision;
  done: number;
}

export interface StripStats {
  enabled: boolean;
  tier: Tier;
  capBytes: number;
  bytes: number;
  media: { id: string; state: Entry["state"]; reason?: string; estimateMs?: number; measuredP95?: number; done: number; frames: number }[];
  served: number;
}

export interface ManagerDeps {
  /** True when the foreground is quiet (not playing, not scrubbing). */
  idle(): boolean;
  /** Overall progress 0..1 while something is building or queued, else null. */
  progress(value: number | null): void;
  /** Test hook: where the cache lives (default: OPFS `overcut-strips`, else memory). */
  store?: () => BlobStore;
  tier?: Tier;
}

const MAX_SEEK_SAMPLES = 24;

function defaultTier(): Tier {
  const n = navigator as Navigator & { deviceMemory?: number };
  return deviceTier({ cores: n.hardwareConcurrency, memoryGb: n.deviceMemory, mobile: /Android|iPhone|iPad|Mobile/i.test(n.userAgent) });
}

export class StripManager {
  private entries = new Map<string, Entry>();
  private queue: Entry[] = [];
  private running: Entry | undefined;
  private enabled = true;
  private capBytes = STRIP_CAP_DEFAULT;
  private cache: MediaCache;
  private generation = 0;
  private served = 0;
  private lastPost = 0;
  private readonly tier: Tier;
  private memoryFallback = false;

  constructor(private deps: ManagerDeps) {
    this.tier = deps.tier ?? defaultTier();
    this.cache = this.makeCache();
  }

  private makeCache(): MediaCache {
    let store: BlobStore;
    try {
      store = this.deps.store ? this.deps.store() : typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function" ? new OpfsStore("overcut-strips") : new MemoryStore();
    } catch { store = new MemoryStore(); }
    return new MediaCache(store, this.capBytes);
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (!on) this.cancelAll();
    else for (const e of this.entries.values()) void this.consider(e);
  }

  /** The storage cap (bytes); the least recently used segments go first when it is passed. */
  setCap(bytes: number): void {
    this.capBytes = Math.max(32 * 1024 * 1024, bytes);
    void this.cache.setLimit(this.capBytes);
  }

  /** A media item is open: remember it and, when a strip already exists on disk or the rule says the clip needs one, make it. */
  register(id: string, handle: MediaHandle, fp: string): void {
    const v = handle.info.video;
    const gop = handle.gop?.();
    if (!v || !gop || gop.frames === 0) return;
    const fps = v.fps && v.fps.den > 0 ? v.fps.num / v.fps.den : 30;
    const spec = planStrip(v.width, v.height, fps);
    const e: Entry = { id, handle, fp, spec, base: baseKey(fp, spec), frames: gop.frames, seeks: [], state: "idle", done: 0 };
    this.entries.set(id, e);
    void this.consider(e);
  }

  forget(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    this.queue = this.queue.filter((q) => q !== e);
    e.reader?.clear();
    if (this.running === e) this.generation++; // the build notices and stops
    this.post();
  }

  /** The time an exact seek of this clip took (ms). The rule re-runs when enough samples are in. */
  noteSeek(id: string, ms: number): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.seeks.push(ms);
    if (e.seeks.length > MAX_SEEK_SAMPLES) e.seeks.shift();
    if (e.state === "idle" || e.state === "skipped") void this.consider(e);
  }

  /** The stand-in picture nearest to `index` of `id`, or undefined (no strip yet, or the segment is not built). */
  async picture(id: string, index: number): Promise<StripPic | undefined> {
    const e = this.entries.get(id);
    if (!this.enabled || !e?.reader) return undefined;
    try {
      const p = await e.reader.picture(index);
      if (p) this.served++;
      return p;
    } catch { return undefined; }
  }

  stats(): StripStats {
    return {
      enabled: this.enabled, tier: this.tier, capBytes: this.capBytes, bytes: this.cache.bytes, served: this.served,
      media: [...this.entries.values()].map((e) => ({ id: e.id, state: e.state, reason: e.decision?.reason, estimateMs: e.decision?.estimateMs, measuredP95: e.decision?.measuredP95, done: e.done, frames: e.frames })),
    };
  }

  dispose(): void { this.cancelAll(); this.entries.clear(); }

  // --- internals ---------------------------------------------------------------------------------------------------

  private cancelAll(): void {
    this.generation++;
    this.queue = [];
    for (const e of this.entries.values()) if (e.state === "queued" || e.state === "building") e.state = "idle";
    this.post();
  }

  private async consider(e: Entry): Promise<void> {
    if (!this.enabled || e.state === "queued" || e.state === "building") return;
    try {
      e.manifest ??= await loadManifest(this.cache, e.base, e.spec, e.frames);
      const m = e.manifest;
      e.reader ??= new StripReader(() => this.cache, e.base, e.spec, e.frames, m);
      e.done = m.done.length;
      const complete = m.done.length >= Math.ceil(e.frames / e.spec.segFrames);
      if (complete) { e.state = "ready"; return; }
      const v = e.handle.info.video!;
      const gop = e.handle.gop!();
      const d = needsStrip(gop, v.width, v.height, this.tier, e.seeks);
      e.decision = d;
      // Work already on disk (an earlier session got part-way) is finished whenever the rule still says yes; with no samples yet the estimate decides.
      if (!d.build) { if (e.state !== "ready") e.state = "skipped"; return; }
      e.state = "queued";
      this.queue.push(e);
      this.post();
      void this.pump();
    } catch { e.state = "skipped"; }
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const e = this.queue.shift();
    if (!e) { this.post(); return; }
    this.running = e;
    this.building.done = 0;
    e.state = "building";
    const gen = this.generation;
    try {
      const res = await buildStrip({
        handle: e.handle, cache: this.cache, base: e.base, spec: e.spec, manifest: e.manifest!, capBytes: this.capBytes,
        cancelled: () => gen !== this.generation || !this.enabled || this.entries.get(e.id) !== e,
        idle: () => this.deps.idle(),
        progress: (done) => { e.done = Math.ceil(done / e.spec.segFrames); this.post(done); },
        onStoreFailure: () => {
          if (this.memoryFallback) return undefined;
          this.memoryFallback = true;
          this.cache = new MediaCache(new MemoryStore(), Math.min(this.capBytes, 128 * 1024 * 1024));
          return this.cache;
        },
      });
      e.state = res === "done" ? "ready" : res === "cancelled" ? "idle" : "skipped";
    } catch { e.state = "skipped"; }
    this.running = undefined;
    this.post();
    void this.pump();
  }

  private building = { done: 0 };

  private post(doneFrames?: number): void {
    if (doneFrames !== undefined) this.building.done = doneFrames;
    const now = performance.now();
    const active = [...this.entries.values()].filter((e) => e.state === "building" || e.state === "queued");
    if (active.length === 0) { this.deps.progress(null); this.lastPost = now; return; }
    if (doneFrames !== undefined && now - this.lastPost < 200) return;
    this.lastPost = now;
    let done = 0, total = 0;
    for (const e of active) { total += e.frames; done += e.state === "building" ? this.building.done : 0; }
    this.deps.progress(total > 0 ? Math.min(1, done / total) : 0);
  }
}
