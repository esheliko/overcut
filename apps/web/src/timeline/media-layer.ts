/** Real waveforms and filmstrips for the timeline canvas (M1-013), kept apart from `draw.ts` so timeline interaction work does not collide with it.
 *  Both paint from cached, pre-rendered bitmaps (`drawImage`): audio from 512-column waveform tiles, video from thumbnail ImageBitmaps.
 *  Nothing here builds paths or allocates per frame; data that has not arrived yet draws as a quiet placeholder and triggers a redraw when it lands. */
import type { Engine } from "@app/engine-client";
import { MediaCache, defaultStore, fingerprint } from "../media/cache";
import type { MediaHost } from "../media/host";
import { INTERVALS, THUMB_H, THUMB_W, ThumbService, intervalFor } from "../media/thumbs";
import { TILE_COLS, WaveformService } from "../media/waveform";
import type { Palette } from "./draw";
import type { Scene } from "./scene";
import { LANE, type View } from "./view";

/** Geometry shared with draw.ts's clip body (y offset inside the lane and height). */
export const BODY_Y = 3, BODY_H = LANE - 7;
const WAVE_H = BODY_H - 4;
const FILM_Y = BODY_Y, FILM_H = BODY_H; // r14: the filmstrip is full-bleed inside the rounded body (the name chip floats over it)

export class MediaLayer {
  readonly waveforms: WaveformService;
  readonly thumbs: ThumbService;
  constructor(engine: Pick<Engine, "peaks">, host: MediaHost, cache: MediaCache = new MediaCache(defaultStore())) {
    this.hosts = host;
    this.waveforms = new WaveformService(engine, host, cache);
    this.thumbs = new ThumbService(host, cache);
  }
  private hosts: MediaHost;
  /** Media became readable again (relink, permission restored) or its file changed: drop what was derived while it was offline, free the
   *  old decoder handle and redraw, so waveforms and filmstrips are requested again. */
  async refresh(mediaId: string) {
    await this.hosts.release?.(mediaId);
    this.waveforms.invalidate(mediaId);
    this.waveforms.onChange();
  }
  /** A media file left the project: close its decoder handle and forget its derived state. */
  release(mediaId: string) { return this.refresh(mediaId); }
  /** True while the view is moving AND frames are slow: filmstrips draw as plain tiles so panning and zooming stay fluid; they come back
   *  120 ms after the motion stops. Fast devices never enter this mode. */
  lean = false;
  private px = NaN; private pp = NaN; private lastT = 0; private lastMove = 0; private settleTimer = 0;
  private settle = () => {
    this.settleTimer = 0;
    if (performance.now() - this.lastMove < 120) { this.settleTimer = window.setTimeout(this.settle, 60); return; }
    this.lean = false;
    this.waveforms.onChange();
  };
  /** Call once per frame before drawing. Slow = more than 28 ms since the previous frame while moving. */
  beginFrame(v: View, now: number) {
    const moved = v.scrollX !== this.px || v.pps !== this.pp;
    this.px = v.scrollX; this.pp = v.pps;
    if (moved) {
      if (now - this.lastT > 28 && now - this.lastMove < 100 && !this.lean) this.lean = true;
      this.lastMove = now;
      if (this.lean && !this.settleTimer) this.settleTimer = window.setTimeout(this.settle, 120);
    }
    this.lastT = now;
  }
  /** Set by the canvas: request a redraw when data or tiles arrive. */
  set onChange(cb: () => void) { this.waveforms.onChange = cb; this.thumbs.onChange = cb; }
  /** Call once per frame before drawing: tiles follow the theme colour and pixel ratio. */
  setStyle(p: Palette, dpr: number) { this.waveforms.setStyle({ color: p.audioWave, height: WAVE_H, dpr: Math.min(dpr, 2) }); } // tiles never exceed 2x: cheaper to raster, still crisp
}

/** Waveform for clip `i`, visible part [a, b] (screen x), clip origin `x`, lane top `y`. */
export function drawWaveform(ctx: CanvasRenderingContext2D, layer: MediaLayer, scene: Scene, i: number, x: number, a: number, b: number, y: number, v: View, p: Palette) {
  const m = scene.mediaById.get(scene.media[i]!);
  const mid = y + BODY_Y + BODY_H / 2;
  const a0 = ctx.globalAlpha; // a muted or hidden track is drawn faded: keep that
  ctx.fillStyle = p.audioWave;
  ctx.globalAlpha = a0 * 0.5;
  ctx.fillRect(a, mid, b - a, 1); // baseline: visible while data is on its way, under the waveform otherwise
  ctx.globalAlpha = a0;
  if (!m) return;
  const e = layer.waveforms.request(m);
  if (!e.view || e.sampleRate === 0) return;
  const sr = e.sampleRate;
  const bucket = Math.max(5, Math.floor(Math.log2(sr / v.pps))); // tile column = 2^bucket frames, at most 1 column per screen pixel
  const tileFrames = TILE_COLS * 2 ** bucket;
  const tileSec = tileFrames / sr, tileW = tileSec * v.pps;
  const src = scene.srcIn[i]!;
  const t0 = Math.max(0, Math.floor((src + (a - x) / v.pps) / tileSec));
  const t1 = Math.floor((src + (b - x) / v.pps) / tileSec);
  const top = y + BODY_Y + 2;
  ctx.imageSmoothingEnabled = false; // tile columns map ~1:1 to pixels; nearest is much cheaper to rasterize than bilinear
  ctx.globalAlpha = a0 * 0.88; // a loud clip fills the lane: keep the shape quieter than the name chips
  for (let t = t0; t <= t1; t++) {
    const tile = layer.waveforms.tile(e, bucket, t);
    if (!tile) continue;
    const tx = x + (t * tileSec - src) * v.pps;
    const x0 = Math.max(a, tx), x1 = Math.min(b, tx + tileW);
    if (x1 <= x0) continue;
    const sx = ((x0 - tx) / tileW) * TILE_COLS, sw = ((x1 - x0) / tileW) * TILE_COLS;
    ctx.drawImage(tile.canvas as CanvasImageSource, sx, 0, sw, tile.canvas.height, x0, top, x1 - x0, WAVE_H);
  }
  ctx.globalAlpha = a0;
}

/** Filmstrip for clip `i`; slots without a bitmap yet are drawn as `p.videoTile` rectangles. */
export function drawFilmstrip(ctx: CanvasRenderingContext2D, layer: MediaLayer, scene: Scene, i: number, x: number, a: number, b: number, y: number, v: View, p: Palette) {
  const m = layer.lean ? undefined : scene.mediaById.get(scene.media[i]!); // lean: no bitmaps, just the placeholder slots
  const thumbW = (FILM_H * THUMB_W) / THUMB_H;
  const iv = intervalFor(v.pps, thumbW), step = INTERVALS[iv]!;
  const slotW = step * v.pps;
  const src = scene.srcIn[i]!;
  const clipEnd = x + (scene.end[i]! - scene.start[i]!) * v.pps - 1;
  const fp = m ? fingerprint(m) : "";
  const k0 = Math.max(0, Math.floor((src + (a - x) / v.pps) / step));
  const k1 = Math.floor((src + (b - x) / v.pps) / step);
  const ty = y + FILM_Y;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = p.videoTile;
  for (let k = k0; k <= k1; k++) {
    const sx = x + (k * step - src) * v.pps;
    const x0 = Math.max(a, sx), x1 = Math.min(b, sx + slotW, clipEnd);
    if (x1 - x0 < 2) continue;
    const bmp = m ? layer.thumbs.get(m, fp, iv, k) : null;
    if (!bmp) { ctx.fillRect(x0, ty, x1 - x0, FILM_H); continue; }
    // "Cover": fit the slot, crop what overflows, so thumbnails of any aspect tile without distortion.
    const slotAspect = slotW / FILM_H, imgAspect = bmp.width / bmp.height;
    let cw = bmp.width, ch = bmp.height, cx = 0, cy = 0;
    if (slotAspect > imgAspect) { ch = bmp.width / slotAspect; cy = (bmp.height - ch) / 2; } else { cw = bmp.height * slotAspect; cx = (bmp.width - cw) / 2; }
    const f0 = (x0 - sx) / slotW, f1 = (x1 - sx) / slotW; // visible fraction of the slot
    ctx.drawImage(bmp, cx + cw * f0, cy, cw * (f1 - f0), ch, x0, ty, x1 - x0, FILM_H);
  }
}
