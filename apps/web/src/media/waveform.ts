/** Waveform data for the timeline: one entry per media fingerprint (extraction job + the engine's parsed peaks), and pre-rendered
 *  tiles drawn from it. A tile is 512 columns of the envelope rendered once into an offscreen canvas; the timeline then paints
 *  visible tiles with `drawImage` (no per-frame path building, no per-frame allocation). */
import type { Engine, MediaRef, PeaksView } from "@app/engine-client";
import { fingerprint, type MediaCache } from "./cache";
import type { MediaHost } from "./host";
import { extractPeaks } from "./peaks-job";

export const TILE_COLS = 512;
const MAX_TILE_BYTES = 64 * 1024 * 1024;
const MAX_PARALLEL_JOBS = 2;

export interface TileStyle { color: string; height: number; dpr: number }

export interface Tile { canvas: OffscreenCanvas | HTMLCanvasElement; final: boolean; version: number; bytes: number }

export interface WaveEntry {
  media: MediaRef;
  fp: string;
  status: "queued" | "running" | "ready" | "none" | "error";
  view: PeaksView | null;
  /** Increases with every published partial file; tiles built from older data are re-rendered. */
  version: number;
  sampleRate: number;
  progress: number;
  /** Tiles by `bucket * 1e9 + tileIndex`. */
  tiles: Map<number, Tile>;
  rendering: Set<number>;
}

const makeCanvas = (w: number, h: number): OffscreenCanvas | HTMLCanvasElement => {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas"); c.width = w; c.height = h; return c;
};

export class WaveformService {
  private entries = new Map<string, WaveEntry>();
  private queue: WaveEntry[] = [];
  private running = 0;
  private style: TileStyle = { color: "#5a74d6", height: 44, dpr: 1 };
  private tileBytes = 0;
  private renderQueue: (() => Promise<void>)[] = [];
  private renderActive = 0;
  /** Called whenever new data or tiles are ready (the canvas redraws). */
  onChange: () => void = () => undefined;
  readonly stats = { jobsStarted: 0, jobsCached: 0, tilesRendered: 0, decodedFrames: 0, decodeMs: 0 };

  constructor(private engine: Pick<Engine, "peaks">, private host: MediaHost, private cache: MediaCache) {}

  /** The entry for a media file; the first call for a fingerprint queues its extraction job. */
  request(media: MediaRef): WaveEntry {
    const fp = fingerprint(media);
    let e = this.entries.get(fp);
    if (!e) {
      e = { media, fp, status: "queued", view: null, version: 0, sampleRate: 0, progress: 0, tiles: new Map(), rendering: new Set() };
      this.entries.set(fp, e);
      this.queue.push(e);
      void this.pump();
    }
    return e;
  }

  /** Tile style (theme colour, lane height, pixel ratio). A change drops every tile so they re-render with the new look. */
  setStyle(s: TileStyle) {
    const o = this.style;
    if (o.color === s.color && o.height === s.height && o.dpr === s.dpr) return;
    this.style = s;
    for (const e of this.entries.values()) { e.tiles.clear(); e.rendering.clear(); }
    this.tileBytes = 0;
  }

  /** A rendered tile if there is one (possibly from slightly older data); otherwise schedules rendering and returns null. */
  tile(e: WaveEntry, bucket: number, index: number): Tile | null {
    const key = bucket * 1e9 + index;
    const t = e.tiles.get(key);
    if (t && (t.final || t.version === e.version)) return t;
    if (e.view && !e.rendering.has(key)) { e.rendering.add(key); this.enqueueRender(e, bucket, index, key); }
    return t ?? null;
  }

  private enqueueRender(e: WaveEntry, bucket: number, index: number, key: number) {
    this.renderQueue.push(() => this.renderTile(e, bucket, index, key));
    if (this.renderQueue.length > 96) { const dropped = this.renderQueue.shift(); void dropped; } // stale requests: newest wins
    void this.drainRender();
  }
  private async drainRender() {
    while (this.renderActive < 3 && this.renderQueue.length) {
      const job = this.renderQueue.pop()!; // newest (what is on screen now) first
      this.renderActive++;
      void job().finally(() => { this.renderActive--; void this.drainRender(); });
    }
  }

  private async renderTile(e: WaveEntry, bucket: number, index: number, key: number) {
    const view = e.view, st = this.style;
    try {
      if (!view) return;
      const fpp = 2 ** bucket;
      const cols = await view.columns(index * TILE_COLS * fpp, fpp, TILE_COLS);
      const h = Math.round(st.height * st.dpr);
      const c = makeCanvas(TILE_COLS, h);
      const g = c.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
      g.fillStyle = st.color;
      const mid = h / 2, k = (h / 2 - 1) / 32768;
      for (let i = 0; i < TILE_COLS; i++) {
        const lo = cols[i * 2]!, hi = cols[i * 2 + 1]!;
        if (lo > hi) continue; // no data yet
        const y0 = mid - hi * k, y1 = mid - lo * k;
        g.fillRect(i, y0, 1, Math.max(1, y1 - y0));
      }
      const wholeBinsEnd = Math.floor(view.frames / 256) * 256;
      const final = view.complete || (index + 1) * TILE_COLS * fpp <= wholeBinsEnd;
      const old = e.tiles.get(key);
      if (old) this.tileBytes -= old.bytes;
      const tile: Tile = { canvas: c, final, version: e.version, bytes: TILE_COLS * h * 4 };
      e.tiles.set(key, tile);
      this.tileBytes += tile.bytes;
      this.stats.tilesRendered++;
      this.trim();
      this.onChange();
    } finally { e.rendering.delete(key); }
  }

  private trim() {
    if (this.tileBytes <= MAX_TILE_BYTES) return;
    for (const e of this.entries.values()) {
      for (const [k, t] of e.tiles) { e.tiles.delete(k); this.tileBytes -= t.bytes; if (this.tileBytes <= MAX_TILE_BYTES * 0.75) return; }
    }
  }

  private async pump() {
    while (this.running < MAX_PARALLEL_JOBS && this.queue.length) {
      const e = this.queue.shift()!;
      this.running++;
      void this.run(e).finally(() => { this.running--; void this.pump(); });
    }
  }

  private async run(e: WaveEntry) {
    e.status = "running";
    this.stats.jobsStarted++;
    let publishing = Promise.resolve();
    const t0 = performance.now();
    try {
      const r = await extractPeaks({
        engine: this.engine, host: this.host, cache: this.cache, media: e.media,
        onFile: (file, progress) => {
          // Parse in order; a slow parse must not let an older file replace a newer one.
          publishing = publishing.then(async () => {
            const view = await this.engine.peaks.open(file);
            const old = e.view;
            e.view = view; e.sampleRate = view.sampleRate; e.progress = progress; e.version++;
            if (old) setTimeout(() => void old.close(), 2000); // tiles may still be reading it
            this.onChange();
          });
        },
      });
      await publishing;
      this.stats.decodedFrames += r.decodedFrames;
      this.stats.decodeMs += performance.now() - t0;
      if (r.cached) this.stats.jobsCached++;
      e.status = r.file ? "ready" : "none";
      this.onChange();
    } catch {
      e.status = "error"; // decorative: the clip simply has no waveform
    }
  }

  /** Resolves when no extraction job is queued or running (tests, bench). */
  async idle() { while (this.running || this.queue.length) await new Promise((r) => setTimeout(r, 20)); }
}
