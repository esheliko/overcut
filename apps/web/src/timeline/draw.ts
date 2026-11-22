/** Canvas painter for the timeline. `drawTimeline` allocates nothing per frame: typed arrays and constants only,
 *  one fillStyle per track pass (no paths: software rasterizers are slow on thousands of sub-rects), ruler labels cached by second. Only clips intersecting the viewport are touched (binary search per visible track). */
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
/** Reads the CSS design tokens so the canvas follows the theme (falls back to DARK). */
export function paletteFromCss(el: Element): Palette {
  const cs = getComputedStyle(el);
  const get = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
  return { ...DARK, bg: get("--bg", DARK.bg), surface: get("--surface", DARK.surface), line: get("--line", DARK.line), lineStrong: get("--line-strong", DARK.lineStrong), fg: get("--fg", DARK.fg), muted: get("--muted", DARK.muted), accent: get("--accent", DARK.accent), videoStrip: get("--accent", DARK.accent) };
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

export interface DrawStats { clipsDrawn: number; tracksDrawn: number }

/** `dpr` is applied via setTransform; callers pass the device pixel ratio the backing store was sized with. */
export function drawTimeline(ctx: CanvasRenderingContext2D, scene: Scene, v: View, playheadSec: number, dpr: number, p: Palette, stats: DrawStats) {
  const W = v.width, H = v.height;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = p.surface;
  ctx.fillRect(0, 0, W, H);

  const t0 = (v.scrollX - 0) / v.pps; // time at x = GUTTER
  const t1 = t0 + (W - GUTTER) / v.pps;
  const firstTrack = Math.max(0, Math.floor(v.scrollY / LANE));
  const lastTrack = Math.min(scene.trackCount - 1, Math.floor((v.scrollY + H - RULER) / LANE));
  let drawn = 0;

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
      ctx.fillStyle = audio ? p.audioBody : p.videoBody;
      ctx.fillRect(x0, y + 3, x1 - x0, LANE - 7);
      ctx.fillStyle = audio ? p.audioStrip : p.videoStrip;
      ctx.fillRect(x0, y + 3, x1 - x0, 2);
      drawn++;
    }
    const last = i;
    // Pass 2: filmstrip tiles (video) or waveform bars (audio) as one path, only when readable.
    ctx.fillStyle = audio ? p.audioWave : p.videoTile;
    for (i = first; i < last; i++) {
      const x = timeToX(v, scene.start[i]!);
      const w = (scene.end[i]! - scene.start[i]!) * v.pps - 1;
      if (w < 28) continue;
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
      if (room > 24) ctx.fillText(scene.name[i]!, tx, y + 7, room);
    }
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
