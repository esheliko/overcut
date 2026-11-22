/** Canvas painter for the timeline. `drawTimeline` allocates nothing per frame: typed arrays and constants only,
 *  one fillStyle per track pass (no paths: software rasterizers are slow on thousands of sub-rects), ruler labels cached by second. Only clips intersecting the viewport are touched (binary search per visible track). */
import { readColors } from "../theme/tokens";
import { firstEndingAfter, type Scene } from "./scene";
import { GUTTER, LANE, RULER, tickStep, timeToX, type View } from "./view";

export interface Palette {
  bg: string; surface: string; line: string; lineStrong: string; fg: string; muted: string; accent: string;
  videoBody: string; videoTile: string; audioBody: string; audioWave: string; videoStrip: string; audioStrip: string;
}
export const DARK: Palette = {
  bg: "#08080a", surface: "#131316", line: "rgba(255,255,255,0.08)", lineStrong: "rgba(255,255,255,0.18)", fg: "#f4f4f6", muted: "#9a9aa6", accent: "#2de2d6",
  videoBody: "#17403f", videoTile: "#1d5654", videoStrip: "#2de2d6", audioBody: "#1f2c4d", audioWave: "#5a74d6", audioStrip: "#6c8cff",
};
/** Reads the design tokens (theme/tokens.ts) so the canvas follows the active theme, including light and high contrast. */
export function paletteFromCss(el: Element): Palette {
  const c = readColors(el.ownerDocument.documentElement);
  const get = (v: string, fb: string) => v || fb;
  return {
    bg: get(c.bg, DARK.bg), surface: get(c.surface, DARK.surface), line: get(c.line, DARK.line), lineStrong: get(c["line-strong"], DARK.lineStrong),
    fg: get(c.fg, DARK.fg), muted: get(c.muted, DARK.muted), accent: get(c.accent, DARK.accent),
    videoBody: get(c.clip, DARK.videoBody), videoTile: get(c["accent-soft"], DARK.videoTile), videoStrip: get(c.accent, DARK.videoStrip),
    audioBody: get(c["surface-3"], DARK.audioBody), audioWave: get(c.muted, DARK.audioWave), audioStrip: get(c.muted, DARK.audioStrip),
  };
}

const labels = new Map<number, string>();
function label(sec: number): string {
  const key = Math.round(sec * 10);
  let s = labels.get(key);
  if (s === undefined) {
    const whole = Math.floor(sec);
    const frac = sec - whole;
    s = `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}${frac > 0.001 ? "." + String(Math.round(frac * 10)) : ""}`;
    labels.set(key, s);
  }
  return s;
}

const FONT = '500 10.5px Inter, system-ui, sans-serif';
const FONT_CLIP = '600 11px Inter, system-ui, sans-serif';
const FONT_HEAD = '600 11px Inter, system-ui, sans-serif';
const TILE_W = 54;
const BAR = 3;

/** Editing state the painter shows on top of the scene. Plain mutable fields owned by the canvas; nothing here is project data. */
export interface Overlay {
  /** Per clip index: 1 = selected, 2 = selected and being dragged or trimmed (its body is not drawn; a ghost is). */
  selected: Uint8Array | null;
  /** Move preview: the clips, the shift in seconds, and the track every ghost sits on (-1 = each clip's own track). */
  ghosts: number[] | null; ghostDSec: number; ghostTrack: number;
  /** Trim preview: clip index (-1 none), which edge, and the new boundary in seconds. */
  trimClip: number; trimEnd: boolean; trimSec: number;
  marquee: { x0: number; y0: number; x1: number; y1: number } | null;
}
export const newOverlay = (): Overlay => ({ selected: null, ghosts: null, ghostDSec: 0, ghostTrack: -1, trimClip: -1, trimEnd: false, trimSec: 0, marquee: null });

const NO_UI: Overlay = newOverlay();

export interface DrawStats { clipsDrawn: number; tracksDrawn: number }

/** `dpr` is applied via setTransform; callers pass the device pixel ratio the backing store was sized with. */
export function drawTimeline(ctx: CanvasRenderingContext2D, scene: Scene, v: View, playheadSec: number, dpr: number, p: Palette, stats: DrawStats, ui: Overlay = NO_UI) {
  const W = v.width, H = v.height;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = p.surface;
  ctx.fillRect(0, 0, W, H);

  const t0 = (v.scrollX - 0) / v.pps; // time at x = GUTTER
  const t1 = t0 + (W - GUTTER) / v.pps;
  const firstTrack = Math.max(0, Math.floor(v.scrollY / LANE));
  const lastTrack = Math.min(scene.trackCount - 1, Math.floor((v.scrollY + H - RULER) / LANE));
  let drawn = 0;
  const sel = ui.selected;

  // Lane backgrounds and separators.
  ctx.fillStyle = p.line;
  for (let t = firstTrack; t <= lastTrack; t++) {
    const y = RULER + t * LANE - v.scrollY;
    ctx.fillRect(GUTTER, y + LANE - 1, W - GUTTER, 1);
  }

  // Clips, one batch per kind: fills share a fillStyle, tiles/waveforms are a single path each.
  for (let t = firstTrack; t <= lastTrack; t++) {
    const audio = scene.trackKind[t] === 1;
    const y = RULER + t * LANE - v.scrollY;
    const lo = scene.trackFirst[t]!, hi = scene.trackFirst[t + 1]!;
    let i = firstEndingAfter(scene, lo, hi, t0);
    // Pass 1: bodies and top strips.
    const first = i;
    for (; i < hi && scene.start[i]! < t1; i++) {
      const x = timeToX(v, scene.start[i]!);
      const w = Math.max(1, (scene.end[i]! - scene.start[i]!) * v.pps - 1);
      const x0 = x < GUTTER ? GUTTER : x;
      const x1 = Math.min(W, x + w);
      if (x1 <= x0) continue;
      drawn++;
      if (sel !== null && sel[i] === 2) continue; // being dragged or trimmed: its ghost is drawn instead
      ctx.fillStyle = audio ? p.audioBody : p.videoBody;
      ctx.fillRect(x0, y + 3, x1 - x0, LANE - 7);
      ctx.fillStyle = audio ? p.audioStrip : p.videoStrip;
      ctx.fillRect(x0, y + 3, x1 - x0, 2);
    }
    const last = i;
    // Pass 2: filmstrip tiles (video) or waveform bars (audio) as one path, only when readable.
    ctx.fillStyle = audio ? p.audioWave : p.videoTile;
    for (i = first; i < last; i++) {
      const x = timeToX(v, scene.start[i]!);
      const w = (scene.end[i]! - scene.start[i]!) * v.pps - 1;
      if (w < 28) continue;
      if (sel !== null && sel[i] === 2) continue;
      const a = x < GUTTER ? GUTTER : x;
      const b = Math.min(W, x + w);
      if (audio) {
        const mid = y + 3 + (LANE - 7) / 2;
        // Deterministic pseudo waveform anchored to the clip so it does not shimmer while scrolling.
        let k = Math.ceil((a - x) / BAR);
        for (let bx = x + k * BAR; bx < b; bx += BAR, k++) {
          const h = 3 + 10 * Math.abs(Math.sin((k + i * 13) * 0.61) * Math.sin((k + i) * 0.17 + 1));
          ctx.fillRect(bx, mid - h, 2, h * 2);
        }
      } else {
        const ty = y + 8, th = LANE - 17;
        const k = Math.ceil((a - x) / TILE_W);
        for (let bx = x + k * TILE_W; bx + 2 < b; bx += TILE_W) ctx.fillRect(bx + 2, ty, Math.min(TILE_W - 4, b - bx - 4), th);
      }
    }
    // Pass 3: names where they fit.
    ctx.fillStyle = p.fg;
    ctx.font = FONT_CLIP;
    ctx.textBaseline = "top";
    for (i = first; i < last; i++) {
      const x = timeToX(v, scene.start[i]!);
      const w = (scene.end[i]! - scene.start[i]!) * v.pps - 1;
      if (w < 56) continue;
      const tx = (x < GUTTER ? GUTTER : x) + 6;
      const room = x + w - tx - 6;
      if (room > 24 && !(sel !== null && sel[i] === 2)) ctx.fillText(scene.name[i]!, tx, y + 7, room);
    }
    // Pass 4: selection outline and trim handles (few clips, so strokes are fine).
    if (sel !== null) {
      ctx.strokeStyle = p.accent;
      ctx.lineWidth = 2;
      for (i = first; i < last; i++) {
        if (sel[i] !== 1) continue;
        const x = timeToX(v, scene.start[i]!);
        const w = Math.max(1, (scene.end[i]! - scene.start[i]!) * v.pps - 1);
        ctx.strokeRect(x + 1, y + 4, w - 2, LANE - 9);
        if (w >= 14) { ctx.fillStyle = p.accent; ctx.fillRect(x + 1, y + 4, 4, LANE - 9); ctx.fillRect(x + w - 5, y + 4, 4, LANE - 9); }
      }
    }
  }

  // Drag and trim previews (drawn under the sticky gutter and ruler).
  if (ui.ghosts !== null) {
    for (const i of ui.ghosts) {
      const tr = ui.ghostTrack >= 0 ? ui.ghostTrack : scene.clipTrack[i]!;
      ghost(ctx, v, p, tr, scene.start[i]! + ui.ghostDSec, scene.end[i]! + ui.ghostDSec, scene.trackKind[tr] === 1);
    }
  }
  if (ui.trimClip >= 0) {
    const i = ui.trimClip;
    ghost(ctx, v, p, scene.clipTrack[i]!, ui.trimEnd ? scene.start[i]! : ui.trimSec, ui.trimEnd ? ui.trimSec : scene.end[i]!, scene.trackKind[scene.clipTrack[i]!] === 1);
  }

  // Gutter (sticky) with track labels.
  ctx.fillStyle = p.surface;
  ctx.fillRect(0, RULER, GUTTER, H - RULER);
  ctx.fillStyle = p.lineStrong;
  ctx.fillRect(GUTTER - 1, RULER, 1, H - RULER);
  ctx.fillStyle = p.muted;
  ctx.font = FONT_HEAD;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let t = firstTrack; t <= lastTrack; t++) {
    ctx.fillText(scene.trackName[t]!, GUTTER / 2, RULER + t * LANE - v.scrollY + LANE / 2, GUTTER - 8);
  }

  // Ruler (sticky): adaptive ticks, minor ticks between labelled ones.
  ctx.fillStyle = p.surface;
  ctx.fillRect(0, 0, W, RULER);
  ctx.fillStyle = p.line;
  ctx.fillRect(0, RULER - 1, W, 1);
  const step = tickStep(v.pps);
  const minor = step / (step === 0.2 || step === 2 ? 4 : step === 15 ? 3 : 5);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = FONT;
  ctx.beginPath();
  for (let s = Math.floor(t0 / minor) * minor; s <= t1; s += minor) {
    const x = timeToX(v, s);
    if (x < GUTTER) continue;
    ctx.moveTo(Math.round(x) + 0.5, RULER - 5);
    ctx.lineTo(Math.round(x) + 0.5, RULER - 1);
  }
  ctx.strokeStyle = p.lineStrong;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.beginPath();
  ctx.fillStyle = p.muted;
  const k0 = Math.ceil(t0 / step - 1e-9);
  for (let k = k0; k * step <= t1; k++) {
    const s = k * step;
    const x = timeToX(v, s);
    if (x < GUTTER) continue;
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, RULER);
    ctx.fillText(label(s), x + 5, 9);
  }
  ctx.stroke();
  ctx.fillStyle = p.surface;
  ctx.fillRect(0, 0, GUTTER, RULER);
  ctx.fillStyle = p.lineStrong;
  ctx.fillRect(GUTTER - 1, 0, 1, RULER);

  if (ui.marquee !== null) {
    const m = ui.marquee;
    ctx.fillStyle = p.accent;
    ctx.globalAlpha = 0.18;
    ctx.fillRect(Math.min(m.x0, m.x1), Math.min(m.y0, m.y1), Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0));
    ctx.globalAlpha = 1;
    ctx.strokeStyle = p.accent;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.min(m.x0, m.x1) + 0.5, Math.min(m.y0, m.y1) + 0.5, Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0));
  }

  // Playhead.
  const px = timeToX(v, playheadSec);
  if (px >= GUTTER - 7 && px <= W + 7) {
    ctx.fillStyle = p.fg;
    ctx.fillRect(px - 1, 0, 2, H);
    ctx.beginPath();
    ctx.moveTo(px - 7, 0); ctx.lineTo(px + 7, 0); ctx.lineTo(px + 7, 9); ctx.lineTo(px, 16); ctx.lineTo(px - 7, 9);
    ctx.closePath();
    ctx.fill();
  }
  stats.clipsDrawn = drawn;
  stats.tracksDrawn = lastTrack - firstTrack + 1;
}

/** A translucent copy of a clip at its previewed position. */
function ghost(ctx: CanvasRenderingContext2D, v: View, p: Palette, track: number, startSec: number, endSec: number, audio: boolean) {
  const x = timeToX(v, startSec), w = Math.max(2, (endSec - startSec) * v.pps - 1);
  if (x + w < GUTTER || x > v.width) return;
  const y = RULER + track * LANE - v.scrollY;
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = audio ? p.audioBody : p.videoBody;
  ctx.fillRect(x, y + 3, w, LANE - 7);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = p.accent;
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 4, w - 2, LANE - 9);
}
