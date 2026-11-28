/** Painting of the volume line, fade ramps and fade handles on the audio clips of one lane (`docs/features/clip-audio.md`). Called by `drawTimeline` once per audio lane;
 *  no allocation per frame: typed-array reads, one path per layer, strings only while a drag shows its value. */
import { HANDLE_Y, HANDLES_MIN_W, LINE_BOT, LINE_MIN_W, levelY } from "./audioEdit";
import type { Scene } from "./scene";
import { gut, timeToX, type View } from "./view";

const TICKS = 705_600_000;
const HALO = "rgba(0,0,0,0.5)";
const LINE = "#ffffff";

/** The drag the painter shows instead of the stored values: `clip` = -1 when none. Plain numbers so the overlay record stays one allocation. */
export interface AudioPreview { clip: number; part: number; volume: number; fadeIn: number; fadeOut: number }
export const newAudioPreview = (): AudioPreview => ({ clip: -1, part: 0, volume: 1, fadeIn: 0, fadeOut: 0 });

/** What a clip shows: the dragged values while it is being dragged. */
const vol = (s: Scene, i: number, a: AudioPreview) => (a.clip === i ? a.volume : s.volume[i]!);
const fin = (s: Scene, i: number, a: AudioPreview) => (a.clip === i ? a.fadeIn : s.tFadeIn[i]!);
const fout = (s: Scene, i: number, a: AudioPreview) => (a.clip === i ? a.fadeOut : s.tFadeOut[i]!);

/** The envelope of every audio clip in [first, last) of the lane at `y`: a line at the real level, ramps at the ends. Clips at the default level with no fades draw nothing
 *  unless selected (then a quiet line shows where the level is, ready to be dragged). */
export function drawAudioLines(ctx: CanvasRenderingContext2D, scene: Scene, v: View, W: number, y: number, laneH: number, first: number, last: number, sel: Uint8Array | null, a: AudioPreview): void {
  ctx.save();
  ctx.beginPath(); ctx.rect(gut(v), y, W - gut(v), laneH); ctx.clip(); // a clip scrolled under the track column must not paint over it
  const base = ctx.globalAlpha;
  for (let pass = 0; pass < 2; pass++) { // pass 0: clips that changed (full line), pass 1: selected clips still at their original level (a quiet line)
    ctx.beginPath();
    let n = 0;
    for (let i = first; i < last; i++) {
      if (sel !== null && sel[i] === 2) continue;
      const vl = vol(scene, i, a), fi = fin(scene, i, a), fo = fout(scene, i, a);
      const changed = vl !== 1 || fi > 0 || fo > 0;
      if ((pass === 0) !== changed) continue;
      if (pass === 1 && !(sel !== null && sel[i] === 1)) continue;
      const x = timeToX(v, scene.start[i]!) + 1, w = (scene.end[i]! - scene.start[i]!) * v.pps - 2;
      if (w < LINE_MIN_W || x + w < gut(v) || x > W) continue;
      const yl = levelY(y, vl), yb = y + LINE_BOT;
      const rampIn = Math.min(w / 2, (fi / TICKS) * v.pps), rampOut = Math.min(w / 2, (fo / TICKS) * v.pps);
      if (rampIn > 0) { ctx.moveTo(x, yb); ctx.lineTo(x + rampIn, yl); } else ctx.moveTo(x, yl);
      ctx.lineTo(x + w - rampOut, yl);
      if (rampOut > 0) ctx.lineTo(x + w, yb);
      n++;
    }
    if (n === 0) continue;
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.strokeStyle = HALO; ctx.lineWidth = 4.5; ctx.stroke();
    ctx.strokeStyle = LINE; ctx.lineWidth = 2; ctx.globalAlpha = pass === 0 ? base : base * 0.6; ctx.stroke();
    ctx.globalAlpha = base;
  }
  ctx.restore();
}

/** The two fade handles (white dots on the top edge) of the selected audio clips, drawn over the selection border, and the value of a drag in progress. */
export function drawAudioHandles(ctx: CanvasRenderingContext2D, scene: Scene, v: View, W: number, y: number, first: number, last: number, sel: Uint8Array, a: AudioPreview, font: string): void {
  ctx.beginPath();
  let n = 0;
  for (let i = first; i < last; i++) {
    if (sel[i] !== 1) continue;
    const x = timeToX(v, scene.start[i]!) + 1, w = (scene.end[i]! - scene.start[i]!) * v.pps - 2;
    if (w < HANDLES_MIN_W || x + w < gut(v) || x > W) continue;
    const hi = Math.min(w / 2, (fin(scene, i, a) / TICKS) * v.pps), ho = Math.min(w / 2, (fout(scene, i, a) / TICKS) * v.pps);
    const cy = y + HANDLE_Y;
    const ax = Math.max(x + hi, gut(v) + 5), bx = Math.min(x + w - ho, W - 5);
    if (ax > gut(v) && ax < W) { ctx.moveTo(ax + 5, cy); ctx.arc(ax, cy, 5, 0, Math.PI * 2); n++; }
    if (bx > gut(v) && bx < W) { ctx.moveTo(bx + 5, cy); ctx.arc(bx, cy, 5, 0, Math.PI * 2); n++; }
  }
  if (n > 0) {
    ctx.fillStyle = LINE; ctx.fill();
    ctx.strokeStyle = HALO; ctx.lineWidth = 1.5; ctx.stroke();
  }
  // The number of a drag: next to the thing being dragged, so it is read where the eyes are.
  const i = a.clip;
  if (i >= first && i < last && a.part > 0) {
    const x = timeToX(v, scene.start[i]!) + 1, w = (scene.end[i]! - scene.start[i]!) * v.pps - 2;
    const text = a.part === 1 ? `${Math.round(a.volume * 100)}%` : `${Math.round(((a.part === 2 ? a.fadeIn : a.fadeOut) / TICKS) * 100) / 100} s`;
    const px = a.part === 1 ? x + w / 2 : a.part === 2 ? x + Math.min(w / 2, (a.fadeIn / TICKS) * v.pps) : x + w - Math.min(w / 2, (a.fadeOut / TICKS) * v.pps);
    const py = a.part === 1 ? levelY(y, a.volume) - 14 : y + HANDLE_Y + 18;
    ctx.font = font; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const tw = ctx.measureText(text).width + 12, cx = Math.min(Math.max(px, gut(v) + tw / 2 + 2), W - tw / 2 - 2);
    ctx.fillStyle = "rgba(0,0,0,0.78)"; ctx.fillRect(cx - tw / 2, py - 9, tw, 18);
    ctx.fillStyle = "#fff"; ctx.fillText(text, cx, py + 0.5);
    ctx.textAlign = "start";
  }
}
