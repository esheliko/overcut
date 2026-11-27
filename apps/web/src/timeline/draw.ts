/** Canvas painter for the timeline. `drawTimeline` allocates nothing per frame: typed arrays and constants only,
 *  one fillStyle per track pass (no paths: software rasterizers are slow on thousands of sub-rects), ruler labels cached by second. Only clips intersecting the viewport are touched (binary search per visible track). */
import { readColors, readToken } from "../theme/tokens";
import { firstEndingAfter, TICKS_PER_SECOND, type Scene } from "./scene";
import { clipDetail, formatDur, formatTick, gut, LANE, MARKER_NAME_PPS, minorDivisions, RULER, tickStep, timeToX, type View } from "./view";
import { IND, SW, switchX, TOGGLES, togglesFor, type Toggle } from "./header";
import { formatSpeed } from "../inspector/speedModel";
import { CUE_MS } from "./commitCue";
import { drawFilmstrip, drawWaveform, type MediaLayer } from "./media-layer";

export interface Palette {
  bg: string; surface: string; line: string; lineStrong: string; fg: string; muted: string; accent: string;
  videoBody: string; videoTile: string; audioBody: string; audioWave: string; videoStrip: string; audioStrip: string;
  danger: string; accentInk: string;
  /** Clip name colour on a flat body of each kind (dark on a light body, white on a dark one: theme-aware). */
  videoInk: string; audioInk: string;
}
export const DARK: Palette = {
  bg: "#08080a", surface: "#131316", line: "rgba(255,255,255,0.08)", lineStrong: "rgba(255,255,255,0.18)", fg: "#f4f4f6", muted: "#9a9aa6", accent: "#2de2d6",
  videoBody: "#17403f", videoTile: "#1d5654", videoStrip: "#2de2d6", audioBody: "#1c3a33", audioWave: "#5fd1a8", audioStrip: "#3ddc97",
  danger: "#ff6b6b", accentInk: "#04211f", videoInk: "#fff", audioInk: "#fff",
};
/** Black or white, whichever reads better on `bg` (a #rgb / #rrggbb / rgb() colour); white when it cannot be parsed. */
function inkOn(bg: string): string {
  let r = 0, g = 0, b = 0;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(bg);
  if (hex) {
    const h = hex[1]!.length === 3 ? hex[1]!.replace(/./g, "$&$&") : hex[1]!;
    r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
  } else {
    const m = /^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/i.exec(bg);
    if (!m) return "#fff";
    r = +m[1]!; g = +m[2]!; b = +m[3]!;
  }
  const lin = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.3 ? "#0b1a18" : "#fff";
}
/** Reads the design tokens (theme/tokens.ts) so the canvas follows the active theme, including light and high contrast. */
export function paletteFromCss(el: Element): Palette {
  const root = el.ownerDocument.documentElement;
  const c = readColors(root);
  const get = (v: string, fb: string) => v || fb;
  const tok = (n: string, fb: string) => readToken(n, root) || fb; // clip hues are timeline-only tokens (tokens.css), not in COLOR_TOKENS
  const videoBody = get(c.clip, DARK.videoBody), audioBody = tok("clip-audio", DARK.audioBody);
  return {
    videoInk: inkOn(videoBody), audioInk: inkOn(audioBody),
    bg: get(c.bg, DARK.bg), surface: get(c.surface, DARK.surface), line: get(c.line, DARK.line), lineStrong: get(c["line-strong"], DARK.lineStrong),
    fg: get(c.fg, DARK.fg), muted: get(c.muted, DARK.muted), accent: get(c.accent, DARK.accent),
    videoBody, videoTile: get(c["accent-soft"], DARK.videoTile), videoStrip: get(c.accent, DARK.videoStrip),
    audioBody, audioWave: tok("clip-audio-wave", DARK.audioWave), audioStrip: tok("clip-audio-strip", DARK.audioStrip),
    danger: get(c.danger, DARK.danger), accentInk: get(c["accent-ink"], DARK.accentInk),
  };
}

const labels = new Map<number, string>();
/** Ruler text for `sec`, cached (a few hundred distinct values at most): nothing is allocated per frame once seen. */
function label(sec: number, step: number): string {
  const key = Math.round(sec * 10) * 100000 + Math.round(step * 10) % 100000;
  let s = labels.get(key);
  if (s === undefined) { if (labels.size > 2000) labels.clear(); s = formatTick(sec, step); labels.set(key, s); }
  return s;
}

const FONT = '500 11px Inter, system-ui, sans-serif';
const LABEL_SCRIM = "rgba(0,0,0,0.62)", LABEL_FG = "#fff", KEYLINE = "rgba(255,255,255,0.92)", HEAD_KEYLINE = "rgba(0,0,0,0.5)";
/** Corner radius of a clip (V-18) and the pixels left between neighbours on each side. */
const R = 4;
const speedLabels = new Map<number, string>();
/** "2×" for a clip whose speed is not 1 (cached by ratio: nothing allocated per frame once seen). */
function speedLabel(num: number, den: number): string {
  const key = num * 65536 + den;
  let s = speedLabels.get(key);
  if (s === undefined) { s = formatSpeed(num / den); if (speedLabels.size > 200) speedLabels.clear(); speedLabels.set(key, s); }
  return s;
}
const nameWidths = new Map<string, number>();
function nameWidth(ctx: CanvasRenderingContext2D, name: string): number {
  let w = nameWidths.get(name);
  if (w === undefined) { w = ctx.measureText(name).width; if (nameWidths.size > 500) nameWidths.clear(); nameWidths.set(name, w); }
  return w;
}
const fitted = new Map<string, string>();
/** `name` cut with an ellipsis to fit `room` px (cached by name and width: nothing is allocated per frame for a name that fits). */
function fitName(ctx: CanvasRenderingContext2D, name: string, room: number): string {
  if (nameWidth(ctx, name) <= room) return name;
  const key = `${Math.floor(room)}|${name}`;
  let s = fitted.get(key);
  if (s === undefined) {
    let n = name.length;
    while (n > 1 && ctx.measureText(`${name.slice(0, n)}…`).width > room) n--;
    s = `${name.slice(0, n)}…`;
    if (fitted.size > 500) fitted.clear();
    fitted.set(key, s);
  }
  return s;
}
const SCRIM_H = 20;
let scrim: CanvasGradient | null = null, scrimCtx: CanvasRenderingContext2D | null = null;
/** The label scrim, built once per context (a gradient in user space, so it is reused at any y by translating). */
function scrimFor(ctx: CanvasRenderingContext2D): CanvasGradient {
  if (scrim === null || scrimCtx !== ctx) {
    scrim = ctx.createLinearGradient(0, 0, 0, SCRIM_H);
    scrim.addColorStop(0, "rgba(0,0,0,0.62)"); scrim.addColorStop(0.6, "rgba(0,0,0,0.38)"); scrim.addColorStop(1, "rgba(0,0,0,0)");
    scrimCtx = ctx;
  }
  return scrim;
}
/** Adds a rounded rectangle to the current path. Corners are quadratic curves (about half the work of `roundRect`'s arcs for a rasterizer, and at 4 px the eye cannot tell). */
function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (r < 1 || w < 12) { ctx.rect(x, y, w, h); return; } // a sliver of a clip has no visible corners: a plain rectangle is much cheaper to rasterize
  const x1 = x + w, y1 = y + h;
  ctx.moveTo(x + r, y);
  ctx.lineTo(x1 - r, y); ctx.quadraticCurveTo(x1, y, x1, y + r);
  ctx.lineTo(x1, y1 - r); ctx.quadraticCurveTo(x1, y1, x1 - r, y1);
  ctx.lineTo(x + r, y1); ctx.quadraticCurveTo(x, y1, x, y1 - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
const FONT_CLIP = '600 11px Inter, system-ui, sans-serif';
const FONT_HEAD = '600 11px Inter, system-ui, sans-serif';
const TILE_W = 54;
const BAR = 3;

/** Editing state the painter shows on top of the scene. Plain mutable fields owned by the canvas; nothing here is project data. */
export interface Overlay {
  /** Per clip index: 1 = selected, 2 = selected and being dragged or trimmed (its body is not drawn; a ghost is). */
  selected: Uint8Array | null;
  /** Move preview: the clips, the shift in seconds, and the row of each ghost (parallel to `ghosts`; null = each clip's own track). */
  ghosts: number[] | null; ghostDSec: number; ghostTracks: number[] | null;
  /** Trim preview: clip index (-1 none), which edge, and the new boundary in seconds. */
  trimClip: number; trimEnd: boolean; trimSec: number; trimRight: number;
  /** Text on the move ghost instead of the clip name (slip / slide show their amount). */
  ghostLabel: string | null;
  /** Lane (row index, -1 none) a dragged clip or media card would land on: tinted. */
  lane: number;
  marquee: { x0: number; y0: number; x1: number; y1: number } | null;
  /** Where a drag snapped or will drop (seconds): a thin guide line across the tracks. Null = none. */
  guideSec: number | null;
  /** Reordering tracks: the row being carried, the row it would land on, and the pointer y. Null = none. */
  trackDrag: { from: number; to: number; y: number } | null;
  /** A marker being dragged along the ruler: its id and where it would land (seconds). */
  markerDrag: { id: string; sec: number } | null;
  /** The commit cue (commitCue.ts): where an edit landed and when it started (`performance.now()`); `t0 < 0` = none. One record, mutated, never reallocated. */
  cue: { sec: number; t0: number; kind: string };
}
export const newOverlay = (): Overlay => ({ selected: null, ghosts: null, ghostDSec: 0, ghostTracks: null, trimClip: -1, trimEnd: false, trimSec: 0, trimRight: -1, ghostLabel: null, lane: -1, marquee: null, guideSec: null, trackDrag: null, markerDrag: null, cue: { sec: 0, t0: -1, kind: "" } });

const NO_UI: Overlay = newOverlay();

export interface DrawStats { clipsDrawn: number; tracksDrawn: number }

/** `dpr` is applied via setTransform; callers pass the device pixel ratio the backing store was sized with. The playhead is NOT drawn here: it lives on its
 *  own layer (`drawPlayheadStrip`), so playback moves it without repainting clips, ruler and thumbnails. `playheadSec` only keeps ruler labels clear of its head. */
export function drawTimeline(ctx: CanvasRenderingContext2D, scene: Scene, v: View, playheadSec: number, dpr: number, p: Palette, stats: DrawStats, ui: Overlay = NO_UI, media?: MediaLayer) {
  const W = v.width, H = v.height;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  media?.setStyle(p, dpr);
  media?.beginFrame(v, performance.now());
  ctx.fillStyle = p.surface;
  ctx.fillRect(0, 0, W, H);

  const t0 = (v.scrollX - 0) / v.pps; // time at the first pixel right of the headers
  const t1 = t0 + (W - gut(v)) / v.pps;
  const firstTrack = Math.max(0, Math.floor(v.scrollY / LANE));
  const lastTrack = Math.min(scene.trackCount - 1, Math.floor((v.scrollY + H - RULER) / LANE));
  let drawn = 0;
  const sel = ui.selected;

  // Lane separators; a lane without clips gets a faint dashed outline (it takes drops and pastes).
  ctx.fillStyle = p.line;
  for (let t = firstTrack; t <= lastTrack; t++) {
    const y = RULER + t * LANE - v.scrollY;
    ctx.fillRect(gut(v), y + LANE - 1, W - gut(v), 1);
  }
  ctx.save();
  ctx.strokeStyle = p.lineStrong; ctx.globalAlpha = 0.55; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
  for (let t = firstTrack; t <= lastTrack; t++) {
    if (scene.trackFirst[t] !== scene.trackFirst[t + 1]) continue;
    const y = RULER + t * LANE - v.scrollY;
    ctx.beginPath(); rr(ctx, gut(v) + 8.5, y + 5.5, W - gut(v) - 17, LANE - 12, 6); ctx.stroke();
  }
  ctx.restore();

  // Clips, one batch per kind: fills share a fillStyle, tiles/waveforms are a single path each.
  for (let t = firstTrack; t <= lastTrack; t++) {
    const audio = scene.trackKind[t] === 1;
    const y = RULER + t * LANE - v.scrollY;
    const lo = scene.trackFirst[t]!, hi = scene.trackFirst[t + 1]!;
    let i = firstEndingAfter(scene, lo, hi, t0);
    if (!scene.trackLive[t]) ctx.globalAlpha = 0.38; // muted, hidden, or silenced by another track's solo: faded, still editable
    // Pass 1: bodies (rounded, one path) and top strips (one path).
    const first = i;
    ctx.beginPath();
    for (; i < hi && scene.start[i]! < t1; i++) {
      const x = timeToX(v, scene.start[i]!) + 1;
      const w = Math.max(1, (scene.end[i]! - scene.start[i]!) * v.pps - 2);
      const x0 = x < gut(v) ? gut(v) : x;
      const x1 = Math.min(W, x + w);
      if (x1 <= x0) continue;
      drawn++;
      if (sel !== null && sel[i] === 2) continue; // being dragged or trimmed: its ghost is drawn instead
      rr(ctx, x0, y + 3, x1 - x0, LANE - 7, R);
    }
    ctx.fillStyle = audio ? p.audioBody : p.videoBody;
    ctx.fill();
    const last = i;
    ctx.beginPath();
    for (i = first; i < last; i++) {
      if (sel !== null && sel[i] === 2) continue;
      const x = timeToX(v, scene.start[i]!) + 1;
      const w = Math.max(1, (scene.end[i]! - scene.start[i]!) * v.pps - 2);
      const x0 = x < gut(v) ? gut(v) : x;
      const x1 = Math.min(W, x + w);
      if (x1 <= x0) continue;
      const inset = x1 - x0 > 14 ? R : 0;
      ctx.rect(x0 + (x === x0 ? inset : 0), y + 3, x1 - x0 - (x === x0 ? inset : 0) - (x1 === x + w ? inset : 0), 2);
    }
    ctx.fillStyle = audio ? p.audioStrip : p.videoStrip;
    ctx.fill();
    // Pass 2: filmstrip tiles (video) or waveform bars (audio) as one path, only when readable.
    ctx.fillStyle = audio ? p.audioWave : p.videoTile;
    for (i = first; i < last; i++) {
      const x = timeToX(v, scene.start[i]!) + 1;
      const w = (scene.end[i]! - scene.start[i]!) * v.pps - 2;
      if (clipDetail(w) === "block") continue;
      if (sel !== null && sel[i] === 2) continue;
      const a = x < gut(v) ? gut(v) : x;
      const b = Math.min(W, x + w);
      if (media) { // real waveform / filmstrip from cached tiles (media-layer.ts), clipped to the rounded body
        ctx.save();
        ctx.beginPath(); rr(ctx, a, y + 3, b - a, LANE - 7, R); ctx.clip();
        if (audio) drawWaveform(ctx, media, scene, i, x, a, b, y, v, p);
        else drawFilmstrip(ctx, media, scene, i, x, a, b, y, v, p);
        ctx.restore();
        continue;
      }
      if (audio) {
        const mid = y + 3 + (LANE - 7) / 2;
        // Deterministic pseudo waveform (placeholder) anchored to the clip so it does not shimmer while scrolling.
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
    // Pass 3: names where they fit, plain text (no box, no shadow: one fillText each), cut with an ellipsis. Over real thumbnails a cached top gradient (0 to .55 black over 18 px)
    // keeps white text readable in every theme; on a flat body the colour follows the body (dark on a light one).
    ctx.font = FONT_CLIP;
    ctx.textBaseline = "top";
    const thumbs = media !== undefined && !audio;
    if (thumbs) {
      ctx.save(); ctx.translate(0, y + 5); ctx.fillStyle = scrimFor(ctx);
      for (i = first; i < last; i++) {
        const x = timeToX(v, scene.start[i]!) + 1, w = (scene.end[i]! - scene.start[i]!) * v.pps - 2;
        if (clipDetail(w) !== "name" || !scene.mediaById.has(scene.media[i]!) || (sel !== null && sel[i] === 2)) continue;
        const a = (x < gut(v) ? gut(v) : x) + R, b = Math.min(W, x + w) - R;
        if (b > a) ctx.fillRect(a, 0, b - a, SCRIM_H);
      }
      ctx.restore();
    }
    const flatInk = audio ? p.audioInk : p.videoInk;
    for (i = first; i < last; i++) {
      const x = timeToX(v, scene.start[i]!) + 1;
      const w = (scene.end[i]! - scene.start[i]!) * v.pps - 2;
      if (clipDetail(w) !== "name") continue;
      const tx = (x < gut(v) ? gut(v) : x) + 7;
      const room = x + w - tx - 6;
      if (room > 24 && !(sel !== null && sel[i] === 2)) {
        ctx.fillStyle = thumbs && scene.mediaById.has(scene.media[i]!) ? LABEL_FG : flatInk;
        ctx.fillText(fitName(ctx, scene.name[i]!, room), tx, y + 8.5);
      }
    }
    // Speed badge (bottom left, under the name): only clips that do not play at 1x.
    for (i = first; i < last; i++) {
      const sn = scene.speedNum[i]!, sd = scene.speedDen[i]!;
      if (sn === sd) continue;
      const x = timeToX(v, scene.start[i]!) + 1;
      const w = (scene.end[i]! - scene.start[i]!) * v.pps - 2;
      const tx = (x < gut(v) ? gut(v) : x) + 7;
      const room = x + w - tx - 6;
      if (room < 30 || (sel !== null && sel[i] === 2)) continue;
      const text = speedLabel(sn, sd);
      const tw = Math.min(room, nameWidth(ctx, text));
      ctx.fillStyle = LABEL_SCRIM;
      ctx.beginPath(); rr(ctx, tx - 4, y + LANE - 24, tw + 8, 15, 3); ctx.fill();
      ctx.fillStyle = LABEL_FG;
      ctx.fillText(text, tx, y + LANE - 22, room);
    }
    ctx.globalAlpha = 1;
    // Pass 4: selection (V-12): a wash over the body, a 2 px accent outline all round with a light keyline outside it, and grips at both ends. One path per layer
    // for every selected clip of the lane, so "select all" on a busy timeline costs a handful of draw calls, not a few per clip.
    if (scene.trackLocked[t]) { ctx.fillStyle = p.line; ctx.fillRect(gut(v), y, W - gut(v), LANE - 1); } // locked: a veil over the lane
    if (sel !== null) {
      let n = 0;
      ctx.beginPath();
      for (i = first; i < last; i++) {
        if (sel[i] !== 1) continue;
        const x = timeToX(v, scene.start[i]!) + 1, w = Math.max(1, (scene.end[i]! - scene.start[i]!) * v.pps - 2);
        rr(ctx, x, y + 3, w, LANE - 7, R); n++;
      }
      if (n > 0) {
        const full = n <= 24; // "select all" on a busy lane: the wash and the outline only (the keyline and the grips are for the few clips you are working on)
        ctx.fillStyle = p.accent; ctx.globalAlpha = 0.16; ctx.fill(); ctx.globalAlpha = 1;
        if (full) {
          ctx.beginPath();
          for (i = first; i < last; i++) {
            if (sel[i] !== 1) continue;
            const x = timeToX(v, scene.start[i]!) + 1, w = Math.max(1, (scene.end[i]! - scene.start[i]!) * v.pps - 2);
            rr(ctx, x - 0.5, y + 2.5, w + 1, LANE - 6, R + 1);
          }
          ctx.strokeStyle = KEYLINE; ctx.lineWidth = 1; ctx.stroke();
        }
        ctx.beginPath();
        for (i = first; i < last; i++) {
          if (sel[i] !== 1) continue;
          const x = timeToX(v, scene.start[i]!) + 1, w = Math.max(1, (scene.end[i]! - scene.start[i]!) * v.pps - 2);
          rr(ctx, x + 1, y + 4, w - 2, LANE - 9, R - 1);
        }
        ctx.strokeStyle = p.accent; ctx.lineWidth = 2; ctx.stroke();
        const gy = y + 3 + (LANE - 7 - 20) / 2;
        if (full) {
          ctx.beginPath();
          for (i = first; i < last; i++) {
            if (sel[i] !== 1) continue;
            const x = timeToX(v, scene.start[i]!) + 1, w = (scene.end[i]! - scene.start[i]!) * v.pps - 2;
            if (w >= 20) { rr(ctx, x + 2, gy, 6, 20, 3); rr(ctx, x + w - 8, gy, 6, 20, 3); }
          }
          ctx.fillStyle = p.accent; ctx.fill();
          ctx.beginPath();
          for (i = first; i < last; i++) {
            if (sel[i] !== 1) continue;
            const x = timeToX(v, scene.start[i]!) + 1, w = (scene.end[i]! - scene.start[i]!) * v.pps - 2;
            if (w >= 20) { ctx.rect(x + 4, gy + 7, 2, 2); ctx.rect(x + 4, gy + 11, 2, 2); ctx.rect(x + w - 6, gy + 7, 2, 2); ctx.rect(x + w - 6, gy + 11, 2, 2); }
          }
          ctx.fillStyle = p.accentInk; ctx.fill();
        }
        for (i = first; i < last; i++) {
          if (sel[i] !== 1 || scene.keys.size === 0) continue;
          const x = timeToX(v, scene.start[i]!) + 1, w = Math.max(1, (scene.end[i]! - scene.start[i]!) * v.pps - 2);
          const keys = w >= 60 ? scene.keys.get(i) : undefined; // keyframe diamonds on the selected clip (skipped when it is too narrow to read)
          if (!keys) continue;
          ctx.fillStyle = "#fff"; ctx.strokeStyle = p.accent; ctx.lineWidth = 1.5;
          const cy = y + LANE - 13, r = 5.5;
          for (const k of keys) {
            const kx = timeToX(v, k);
            if (kx < Math.max(gut(v), x) || kx > Math.min(W, x + w)) continue;
            ctx.beginPath(); ctx.moveTo(kx, cy - r); ctx.lineTo(kx + r, cy); ctx.lineTo(kx, cy + r); ctx.lineTo(kx - r, cy); ctx.closePath(); ctx.fill(); ctx.stroke();
          }
        }
      }
    }
  }

  // Drag and trim previews (drawn under the sticky gutter and ruler).
  if (ui.lane >= 0 && ui.lane < scene.trackCount) {
    const ly = RULER + ui.lane * LANE - v.scrollY;
    ctx.save(); ctx.globalAlpha = 0.14; ctx.fillStyle = p.accent; ctx.fillRect(gut(v), ly, v.width - gut(v), LANE - 1); ctx.restore();
  }
  if (ui.ghosts !== null) {
    for (let n = 0; n < ui.ghosts.length; n++) {
      const i = ui.ghosts[n]!;
      // A lane change gives each ghost its own row (clips of the other kind, like a linked sound, stay on their track).
      const tr = ui.ghostTracks !== null ? ui.ghostTracks[n]! : scene.clipTrack[i]!;
      const dur = scene.end[i]! - scene.start[i]!;
      const many = ui.ghosts.length > 16; // dragging a big selection: plain boxes (no names, no rounding), the cost stays flat
      ghost(ctx, v, p, tr, scene.start[i]! + ui.ghostDSec, scene.end[i]! + ui.ghostDSec, tr >= scene.trackCount || scene.trackKind[tr] === 1, many ? "" : ui.ghostLabel ?? `${scene.name[i]} · ${formatDur(dur)}`, many);
    }
  }
  if (ui.trimClip >= 0) {
    const i = ui.trimClip;
    const a = ui.trimEnd ? scene.start[i]! : ui.trimSec, b = ui.trimEnd ? ui.trimSec : scene.end[i]!;
    ghost(ctx, v, p, scene.clipTrack[i]!, a, b, scene.trackKind[scene.clipTrack[i]!] === 1, `${scene.name[i]} · ${formatDur(b - a)}`);
    if (ui.trimRight >= 0) ghost(ctx, v, p, scene.clipTrack[ui.trimRight]!, ui.trimSec, scene.end[ui.trimRight]!, scene.trackKind[scene.clipTrack[ui.trimRight]!] === 1); // a seam: the right clip follows the boundary
  }

  if (ui.guideSec !== null) {
    const gx = Math.round(timeToX(v, ui.guideSec)) + 0.5;
    if (gx >= gut(v) && gx <= v.width) {
      ctx.strokeStyle = p.accent;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(gx, RULER); ctx.lineTo(gx, v.height); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  if (ui.cue.t0 >= 0) { // commit cue: two hairlines open away from the edit and fade (a ripple / gap close: a soft band), so the eye lands on what changed
    const k = Math.min(1, (performance.now() - ui.cue.t0) / CUE_MS);
    const cx = timeToX(v, ui.cue.sec);
    if (k < 1 && cx >= gut(v) - 20 && cx <= v.width + 20) {
      const fade = (1 - k) * (1 - k);
      ctx.fillStyle = p.accent;
      if (ui.cue.kind === "ripple" || ui.cue.kind === "gap") {
        ctx.globalAlpha = 0.32 * fade;
        ctx.fillRect(Math.round(cx - 14), RULER, 28, v.height - RULER);
      } else {
        const d = 2 + 12 * (1 - fade); // the lines drift apart: the cut "opens"
        ctx.globalAlpha = 0.16 * fade;
        ctx.fillRect(Math.round(cx - d), RULER, Math.round(d * 2), v.height - RULER);
        ctx.globalAlpha = 0.95 * fade;
        ctx.fillRect(Math.round(cx - d - 1), RULER, 2, v.height - RULER);
        ctx.fillRect(Math.round(cx + d - 1), RULER, 2, v.height - RULER);
      }
      ctx.globalAlpha = 1;
    }
  }

  // Gutter (sticky) with the track headers.
  ctx.fillStyle = p.surface;
  ctx.fillRect(0, RULER, gut(v), H - RULER);
  ctx.fillStyle = p.lineStrong;
  ctx.fillRect(gut(v) - 1, RULER, 1, H - RULER);
  ctx.fillStyle = p.line;
  for (let t = firstTrack; t <= lastTrack; t++) ctx.fillRect(0, RULER + t * LANE - v.scrollY + LANE - 1, gut(v), 1);
  for (let t = firstTrack; t <= lastTrack; t++) header(ctx, scene, v, p, t, RULER + t * LANE - v.scrollY, ui.trackDrag?.from === t);
  const td = ui.trackDrag;
  if (td !== null) { // reordering: a line where the track will land, the carried header under the pointer
    const ly = RULER + (td.to + (td.to > td.from ? 1 : 0)) * LANE - v.scrollY;
    ctx.fillStyle = p.accent;
    ctx.fillRect(0, ly - 1, W, 3);
    ctx.globalAlpha = 0.9;
    const y = Math.max(RULER, Math.min(H - LANE, td.y - LANE / 2));
    ctx.fillStyle = p.surface; ctx.fillRect(0, y, gut(v), LANE);
    header(ctx, scene, v, p, td.from, y, true);
    ctx.strokeStyle = p.accent; ctx.lineWidth = 2; ctx.strokeRect(1, y + 1, gut(v) - 2, LANE - 2);
    ctx.globalAlpha = 1;
  }
  const total = scene.trackCount * LANE, viewH = H - RULER;
  if (total > viewH) { // a thin scroll thumb: there are more tracks than fit
    const th = Math.max(24, (viewH * viewH) / total), ty = RULER + (v.scrollY / (total - viewH)) * (viewH - th);
    ctx.fillStyle = p.lineStrong;
    ctx.fillRect(W - 4, ty, 3, th);
  }

  // Ruler (sticky): adaptive ticks with a hierarchy (full-height labelled ticks, a taller middle tick, short minor ticks).
  ctx.fillStyle = p.surface;
  ctx.fillRect(0, 0, W, RULER);
  ctx.fillStyle = p.line;
  ctx.fillRect(0, RULER - 1, W, 1);
  const step = tickStep(v.pps);
  const div = minorDivisions(step);
  const minor = step / div;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = FONT;
  ctx.strokeStyle = p.lineStrong;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  for (let s = Math.floor(t0 / minor) * minor; s <= t1; s += minor) {
    const x = timeToX(v, s);
    if (x < gut(v)) continue;
    if (div % 2 === 0 && Math.round(s / minor) % div === div / 2) continue; // the middle tick is drawn taller below
    ctx.moveTo(Math.round(x) + 0.5, RULER - 5);
    ctx.lineTo(Math.round(x) + 0.5, RULER - 1);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  if (div % 2 === 0) {
    ctx.beginPath();
    for (let s = Math.floor(t0 / minor) * minor; s <= t1; s += minor) {
      const x = timeToX(v, s);
      if (x < gut(v) || Math.round(s / minor) % div !== div / 2) continue;
      ctx.moveTo(Math.round(x) + 0.5, RULER - 9);
      ctx.lineTo(Math.round(x) + 0.5, RULER - 1);
    }
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.fillStyle = p.muted;
  const phx = timeToX(v, playheadSec);
  const k0 = Math.ceil(t0 / step - 1e-9);
  for (let k = k0; k * step <= t1; k++) {
    const s = k * step;
    const x = timeToX(v, s);
    if (x < gut(v)) continue;
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, RULER);
    if (x + 6 < phx + 10 && x + 36 > phx - 10) continue; // the playhead's head sits on this label: leave it out rather than print under the head
    ctx.fillText(label(s, step), x + 6, 9);
  }
  ctx.stroke();
  ctx.fillStyle = p.surface;
  ctx.fillRect(0, 0, gut(v), RULER);
  ctx.fillStyle = p.lineStrong;
  ctx.fillRect(gut(v) - 1, 0, 1, RULER);

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

  // In/out range and markers (M2-046): outside the range the lanes are dimmed, the ruler carries the range band and each marker's flag (a diamond for a chapter).
  ctx.save();
  ctx.beginPath(); ctx.rect(gut(v), 0, W - gut(v), H); ctx.clip();
  if (scene.range) {
    const rx0 = timeToX(v, scene.range.start / TICKS_PER_SECOND), rx1 = timeToX(v, scene.range.end / TICKS_PER_SECOND);
    ctx.fillStyle = p.bg; ctx.globalAlpha = 0.5;
    ctx.fillRect(gut(v), RULER, Math.max(0, rx0 - gut(v)), H - RULER);
    ctx.fillRect(Math.max(rx1, gut(v)), RULER, Math.max(0, W - Math.max(rx1, gut(v))), H - RULER);
    ctx.fillStyle = p.accent; ctx.globalAlpha = scene.loop ? 0.6 : 0.4;
    ctx.fillRect(rx0, RULER - 9, rx1 - rx0, 7);
    ctx.globalAlpha = 1;
    ctx.fillRect(rx0 - 1, 0, 2, RULER); ctx.fillRect(rx1 - 1, 0, 2, RULER);
    if (scene.loop) { ctx.strokeStyle = p.accent; ctx.setLineDash([4, 3]); ctx.strokeRect(rx0 + 0.5, RULER - 8.5, Math.max(0, rx1 - rx0 - 1), 6); ctx.setLineDash([]); }
  }
  let lastMarkerX = -1e9;
  for (const m of scene.markers) {
    const dragged = ui.markerDrag?.id === m.id;
    const x = Math.round(timeToX(v, dragged ? ui.markerDrag!.sec : m.sec)) + 0.5;
    if (x < gut(v) - 12 || x > W + 12) continue;
    if (!dragged && x - lastMarkerX < 4) continue; // zoomed far out: markers closer than 4 px collapse into the first one
    lastMarkerX = x;
    const col = m.colour ?? p.accent;
    ctx.fillStyle = col; ctx.strokeStyle = col;
    ctx.globalAlpha = 0.35; ctx.beginPath(); ctx.moveTo(x, RULER); ctx.lineTo(x, H); ctx.stroke(); ctx.globalAlpha = 1;
    ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, 10); ctx.lineTo(x, RULER); ctx.stroke(); ctx.lineWidth = 1;
    ctx.beginPath();
    if (m.chapter) { ctx.moveTo(x, 12); ctx.lineTo(x + 6, 18); ctx.lineTo(x, 24); ctx.lineTo(x - 6, 18); }
    else { ctx.moveTo(x, 11); ctx.lineTo(x + 11, 15.5); ctx.lineTo(x, 20); }
    ctx.closePath(); ctx.fill();
    if (m.name && v.pps >= MARKER_NAME_PPS) { ctx.fillStyle = p.fg; ctx.textBaseline = "top"; ctx.textAlign = "left"; ctx.font = FONT; ctx.fillText(m.name.length > 14 ? `${m.name.slice(0, 13)}…` : m.name, x + (m.chapter ? 9 : 14), 13); }
  }
  ctx.restore();

  stats.clipsDrawn = drawn;
  stats.tracksDrawn = lastTrack - firstTrack + 1;
}

/** What the playhead layer shows besides the line: a time bubble (the timecode while scrubbing or dragging, T-06) at `sec`. */
export interface Bubble { sec: number; text: string }

export const HEAD_W = 20;
/** The playhead strip (HEAD_W css px wide, the full height of the timeline), drawn with the head centred. It is painted once and then only MOVED (a CSS transform on its own
 *  layer, so panning, zooming and playback never repaint it); it is repainted only when the height, pixel ratio or palette changes. */
export function drawPlayheadStrip(ctx: CanvasRenderingContext2D, H: number, dpr: number, p: Palette) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, HEAD_W, H);
  const x = HEAD_W / 2;
  ctx.fillStyle = p.surface; ctx.fillRect(x - 9, 0, 18, RULER - 1); // clearance: a ruler label never shows in pieces beside the head
  ctx.fillStyle = HEAD_KEYLINE; ctx.fillRect(x - 1.75, 0, 3.5, H);
  ctx.fillStyle = p.accent; ctx.fillRect(x - 0.75, 0, 1.5, H);
  ctx.beginPath();
  ctx.moveTo(x - 6.5, 1.5); ctx.lineTo(x + 6.5, 1.5); ctx.lineTo(x + 6.5, 9); ctx.lineTo(x, 15.5); ctx.lineTo(x - 6.5, 9);
  ctx.closePath();
  ctx.fillStyle = p.accent; ctx.fill();
  ctx.strokeStyle = HEAD_KEYLINE; ctx.lineWidth = 1; ctx.lineJoin = "round"; ctx.stroke(); ctx.lineJoin = "miter";
}

/** The time bubble (T-06) on its own transparent layer, only while one is shown: in the ruler beside the head (or where a dragged clip or trim edge will land). Cleared first. */
export function drawBubble(ctx: CanvasRenderingContext2D, v: View, dpr: number, p: Palette, bubble: Bubble | null) {
  const W = v.width, H = v.height, g = gut(v);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!bubble) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(g, 0, W - g, H); ctx.clip();
  ctx.font = '600 11px Inter, system-ui, sans-serif'; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  const bx = timeToX(v, bubble.sec), tw = ctx.measureText(bubble.text).width, bw = tw + 14;
  const left = bx + 12 + bw <= W - 2 ? bx + 12 : bx - 12 - bw; // flips to the left of the head near the right edge
  const lx = Math.max(g + 2, left);
  ctx.fillStyle = p.fg;
  ctx.beginPath(); rr(ctx, lx, 4, bw, 20, 6); ctx.fill();
  ctx.fillStyle = p.bg;
  ctx.fillText(bubble.text, lx + 7, 14.5);
  ctx.restore();
}

/** A translucent copy of a clip at its previewed position. */
function ghost(ctx: CanvasRenderingContext2D, v: View, p: Palette, track: number, startSec: number, endSec: number, audio: boolean, name = "", plain = false) {
  const x = timeToX(v, startSec) + 1, w = Math.max(2, (endSec - startSec) * v.pps - 2);
  if (x + w < gut(v) || x > v.width) return;
  const y = RULER + track * LANE - v.scrollY;
  if (plain) {
    ctx.globalAlpha = 0.85; ctx.fillStyle = audio ? p.audioBody : p.videoBody; ctx.fillRect(x, y + 3, w, LANE - 7);
    ctx.globalAlpha = 1; ctx.strokeStyle = p.accent; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 4, w - 2, LANE - 9);
    return;
  }
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = audio ? p.audioBody : p.videoBody;
  ctx.beginPath(); rr(ctx, x, y + 3, w, LANE - 7, R); ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = p.accent;
  ctx.lineWidth = 2;
  ctx.beginPath(); rr(ctx, x + 1, y + 4, w - 2, LANE - 9, R - 1); ctx.stroke();
  // The name (and length) ride along, so what is being carried stays readable.
  const tx = Math.max(x, gut(v)) + 7, room = x + w - tx - 6;
  if (name && room > 24) {
    ctx.font = FONT_CLIP; ctx.textAlign = "left"; ctx.textBaseline = "top";
    const text = fitName(ctx, name, room);
    ctx.fillStyle = audio ? p.audioInk : p.videoInk; ctx.fillText(text, tx, y + 9.5);
  }
}

const BADGE = ["V", "A"];
/** One track header in the lane whose top is `y`. Wide (mouse): ONE row, centred in the lane: kind chip, name, then the switches right aligned (borderless, filled when on).
 *  Compact (touch): chip and name, then small indicators of the switches that are on; the whole header is one target. */
function header(ctx: CanvasRenderingContext2D, scene: Scene, v: View, p: Palette, t: number, y: number, lifted: boolean) {
  const audio = scene.trackKind[t] === 1;
  const live = scene.trackLive[t] === 1;
  if (lifted) { ctx.fillStyle = p.line; ctx.fillRect(0, y, gut(v) - 1, LANE - 1); }
  const cy = y + (LANE - 1) / 2; // one-row headers sit on the lane's middle line
  const rowY = v.compact ? y + 15.5 : cy;
  // Kind chip: video takes the accent, audio its own green.
  ctx.fillStyle = audio ? p.audioStrip : p.videoStrip;
  ctx.globalAlpha = live ? 1 : 0.5;
  ctx.beginPath(); rr(ctx, 8, rowY - 8, 16, 16, 4); ctx.fill();
  ctx.fillStyle = p.bg;
  ctx.font = '700 10px Inter, system-ui, sans-serif';
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(BADGE[scene.trackKind[t]!]!, 16, rowY + 0.5);
  ctx.globalAlpha = 1;
  // Name.
  ctx.fillStyle = live ? p.fg : p.muted;
  ctx.font = FONT_HEAD;
  ctx.textAlign = "left";
  if (v.compact) {
    ctx.fillText(scene.trackName[t]!, 30, rowY, gut(v) - 48);
    // A small chevron: the whole header opens the track menu.
    const cx = gut(v) - 12;
    ctx.strokeStyle = p.muted; ctx.lineWidth = 1.5; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(cx - 3.5, rowY - 1.8); ctx.lineTo(cx, rowY + 1.8); ctx.lineTo(cx + 3.5, rowY - 1.8); ctx.stroke();
    ctx.lineCap = "butt"; ctx.lineJoin = "miter";
    let x = IND.x0;
    for (const part of TOGGLES) {
      if (!state(scene, t, part)) continue; // (a video track that still carries an old mute shows it, so it is not invisible)
      glyph(ctx, p, part, x, y + IND.y, IND.size, true);
      x += IND.size + IND.gap;
    }
    return;
  }
  const first = switchX(TOGGLES.length - togglesFor(scene.trackKind[t]!).length, gut(v));
  ctx.fillText(scene.trackName[t]!, 30, rowY, Math.max(20, first - 30 - 4));
  for (const part of togglesFor(scene.trackKind[t]!)) {
    const on = state(scene, t, part), x = switchX(TOGGLES.indexOf(part), gut(v)), by = y + SW.y;
    if (on) { ctx.fillStyle = part === "mute" ? p.danger : part === "solo" ? p.accent : p.fg; ctx.beginPath(); rr(ctx, x, by, SW.w, SW.h, 6); ctx.fill(); }
    glyph(ctx, p, part, x + (SW.w - 14) / 2, by + (SW.h - 14) / 2, 14, on);
  }
}

const state = (s: Scene, t: number, part: Toggle): boolean => (part === "mute" ? s.trackMuted[t] : part === "solo" ? s.trackSolo[t] : part === "lock" ? s.trackLocked[t] : s.trackHidden[t]) === 1;

/** The glyph of a switch in a size x size box at (x, y): M and S letters, a padlock, an eye. `on` draws it dark on the filled button. */
function glyph(ctx: CanvasRenderingContext2D, p: Palette, part: Toggle, x: number, y: number, size: number, on: boolean) {
  const ink = on ? p.bg : p.muted;
  ctx.fillStyle = ink; ctx.strokeStyle = ink; ctx.lineWidth = size > 12 ? 1.5 : 1.2;
  if (part === "mute" || part === "solo") {
    ctx.font = `700 ${Math.round(size * 0.85)}px Inter, system-ui, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(part === "mute" ? "M" : "S", x + size / 2, y + size / 2 + 0.5);
  } else if (part === "lock") {
    const bw = size * 0.7, bh = size * 0.5, bx = x + (size - bw) / 2, by = y + size - bh - 1;
    ctx.fillRect(bx, by, bw, bh);
    ctx.beginPath(); ctx.arc(x + size / 2, by, bw * 0.3, Math.PI, 0); ctx.stroke();
  } else {
    const cx = x + size / 2, cy = y + size / 2, rx = size / 2 - 0.5;
    ctx.beginPath(); ctx.ellipse(cx, cy, rx, size * 0.28, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, size * 0.14, 0, Math.PI * 2); ctx.fill();
    if (on) { ctx.beginPath(); ctx.moveTo(x + 1, y + size - 1); ctx.lineTo(x + size - 1, y + 1); ctx.stroke(); } // hidden: struck through
  }
}
