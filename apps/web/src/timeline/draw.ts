/** Canvas painter for the timeline. `drawTimeline` allocates nothing per frame: typed arrays and constants only,
 *  one fillStyle per track pass (no paths: software rasterizers are slow on thousands of sub-rects), ruler labels cached by second. Only clips intersecting the viewport are touched (binary search per visible track). */
import { readColors } from "../theme/tokens";
import { firstEndingAfter, TICKS_PER_SECOND, type Scene } from "./scene";
import { gut, LANE, RULER, tickStep, timeToX, type View } from "./view";
import { IND, SW, switchX, TOGGLES, togglesFor, type Toggle } from "./header";
import { formatSpeed } from "../inspector/speedModel";
import { drawFilmstrip, drawWaveform, type MediaLayer } from "./media-layer";

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
const LABEL_SCRIM = "rgba(0,0,0,0.62)", LABEL_FG = "#fff";
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
  trimClip: number; trimEnd: boolean; trimSec: number;
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
}
export const newOverlay = (): Overlay => ({ selected: null, ghosts: null, ghostDSec: 0, ghostTracks: null, trimClip: -1, trimEnd: false, trimSec: 0, ghostLabel: null, lane: -1, marquee: null, guideSec: null, trackDrag: null, markerDrag: null });

const NO_UI: Overlay = newOverlay();

export interface DrawStats { clipsDrawn: number; tracksDrawn: number }

/** `dpr` is applied via setTransform; callers pass the device pixel ratio the backing store was sized with. */
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

  // Lane backgrounds and separators.
  ctx.fillStyle = p.line;
  for (let t = firstTrack; t <= lastTrack; t++) {
    const y = RULER + t * LANE - v.scrollY;
    ctx.fillRect(gut(v), y + LANE - 1, W - gut(v), 1);
  }

  // Clips, one batch per kind: fills share a fillStyle, tiles/waveforms are a single path each.
  for (let t = firstTrack; t <= lastTrack; t++) {
    const audio = scene.trackKind[t] === 1;
    const y = RULER + t * LANE - v.scrollY;
    const lo = scene.trackFirst[t]!, hi = scene.trackFirst[t + 1]!;
    let i = firstEndingAfter(scene, lo, hi, t0);
    if (!scene.trackLive[t]) ctx.globalAlpha = 0.38; // muted, hidden, or silenced by another track's solo: faded, still editable
    // Pass 1: bodies and top strips.
    const first = i;
    for (; i < hi && scene.start[i]! < t1; i++) {
      const x = timeToX(v, scene.start[i]!);
      const w = Math.max(1, (scene.end[i]! - scene.start[i]!) * v.pps - 1);
      const x0 = x < gut(v) ? gut(v) : x;
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
      const a = x < gut(v) ? gut(v) : x;
      const b = Math.min(W, x + w);
      if (media) { // real waveform / filmstrip from cached tiles (media-layer.ts)
        if (audio) drawWaveform(ctx, media, scene, i, x, a, b, y, v, p);
        else drawFilmstrip(ctx, media, scene, i, x, a, b, y, v, p);
        continue;
      }
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
    ctx.font = FONT_CLIP;
    ctx.textBaseline = "top";
    for (i = first; i < last; i++) {
      const x = timeToX(v, scene.start[i]!);
      const w = (scene.end[i]! - scene.start[i]!) * v.pps - 1;
      if (w < 56) continue;
      const tx = (x < gut(v) ? gut(v) : x) + 6;
      const room = x + w - tx - 6;
      if (room > 24 && !(sel !== null && sel[i] === 2)) {
        // A dark pill behind the name keeps it readable over any thumbnail, in every theme.
        const name = scene.name[i]!;
        const tw = Math.min(room, nameWidth(ctx, name));
        ctx.fillStyle = LABEL_SCRIM;
        ctx.fillRect(tx - 4, y + 6, tw + 8, 15);
        ctx.fillStyle = LABEL_FG;
        ctx.fillText(name, tx, y + 8, room);
      }
    }
    // Speed badge (bottom left, under the name): only clips that do not play at 1x.
    for (i = first; i < last; i++) {
      const sn = scene.speedNum[i]!, sd = scene.speedDen[i]!;
      if (sn === sd) continue;
      const x = timeToX(v, scene.start[i]!);
      const w = (scene.end[i]! - scene.start[i]!) * v.pps - 1;
      const tx = (x < gut(v) ? gut(v) : x) + 6;
      const room = x + w - tx - 6;
      if (room < 30 || (sel !== null && sel[i] === 2)) continue;
      const text = speedLabel(sn, sd);
      const tw = Math.min(room, nameWidth(ctx, text));
      ctx.fillStyle = LABEL_SCRIM;
      ctx.fillRect(tx - 4, y + LANE - 24, tw + 8, 15);
      ctx.fillStyle = LABEL_FG;
      ctx.fillText(text, tx, y + LANE - 22, room);
    }
    ctx.globalAlpha = 1;
    // Pass 4: selection outline and trim handles (few clips, so strokes are fine).
    if (scene.trackLocked[t]) { ctx.fillStyle = p.line; ctx.fillRect(gut(v), y, W - gut(v), LANE - 1); } // locked: a veil over the lane
    if (sel !== null) {
      ctx.strokeStyle = p.accent;
      ctx.lineWidth = 2;
      for (i = first; i < last; i++) {
        if (sel[i] !== 1) continue;
        const x = timeToX(v, scene.start[i]!);
        const w = Math.max(1, (scene.end[i]! - scene.start[i]!) * v.pps - 1);
        ctx.strokeRect(x + 1, y + 4, w - 2, LANE - 9);
        if (w >= 14) { ctx.fillStyle = p.accent; ctx.fillRect(x + 1, y + 4, 4, LANE - 9); ctx.fillRect(x + w - 5, y + 4, 4, LANE - 9); }
        const keys = w >= 60 ? scene.keys.get(i) : undefined; // keyframe diamonds on the selected clip (skipped when it is too narrow to read)
        if (keys) {
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
      ghost(ctx, v, p, tr, scene.start[i]! + ui.ghostDSec, scene.end[i]! + ui.ghostDSec, tr >= scene.trackCount || scene.trackKind[tr] === 1, ui.ghostLabel ?? scene.name[i]);
    }
  }
  if (ui.trimClip >= 0) {
    const i = ui.trimClip;
    ghost(ctx, v, p, scene.clipTrack[i]!, ui.trimEnd ? scene.start[i]! : ui.trimSec, ui.trimEnd ? ui.trimSec : scene.end[i]!, scene.trackKind[scene.clipTrack[i]!] === 1);
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
    if (x < gut(v)) continue;
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
    if (x < gut(v)) continue;
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, RULER);
    ctx.fillText(label(s), x + 5, 9);
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
  for (const m of scene.markers) {
    const dragged = ui.markerDrag?.id === m.id;
    const x = Math.round(timeToX(v, dragged ? ui.markerDrag!.sec : m.sec)) + 0.5;
    if (x < gut(v) - 12 || x > W + 12) continue;
    const col = m.colour ?? p.accent;
    ctx.fillStyle = col; ctx.strokeStyle = col;
    ctx.globalAlpha = 0.35; ctx.beginPath(); ctx.moveTo(x, RULER); ctx.lineTo(x, H); ctx.stroke(); ctx.globalAlpha = 1;
    ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, 10); ctx.lineTo(x, RULER); ctx.stroke(); ctx.lineWidth = 1;
    ctx.beginPath();
    if (m.chapter) { ctx.moveTo(x, 12); ctx.lineTo(x + 6, 18); ctx.lineTo(x, 24); ctx.lineTo(x - 6, 18); }
    else { ctx.moveTo(x, 11); ctx.lineTo(x + 11, 15.5); ctx.lineTo(x, 20); }
    ctx.closePath(); ctx.fill();
    if (m.name && v.pps >= 20) { ctx.fillStyle = p.fg; ctx.textBaseline = "top"; ctx.textAlign = "left"; ctx.font = FONT; ctx.fillText(m.name.length > 14 ? `${m.name.slice(0, 13)}…` : m.name, x + (m.chapter ? 9 : 14), 13); }
  }
  ctx.restore();

  // Playhead.
  const px = timeToX(v, playheadSec);
  if (px >= gut(v) - 7 && px <= W + 7) {
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
function ghost(ctx: CanvasRenderingContext2D, v: View, p: Palette, track: number, startSec: number, endSec: number, audio: boolean, name = "") {
  const x = timeToX(v, startSec), w = Math.max(2, (endSec - startSec) * v.pps - 1);
  if (x + w < gut(v) || x > v.width) return;
  const y = RULER + track * LANE - v.scrollY;
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = audio ? p.audioBody : p.videoBody;
  ctx.fillRect(x, y + 3, w, LANE - 7);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = p.accent;
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 4, w - 2, LANE - 9);
  // The name rides along on a dark pill (same as the clip labels), so what is being carried stays readable.
  const tx = Math.max(x, gut(v)) + 6, room = x + w - tx - 6;
  if (name && room > 24) {
    ctx.font = FONT_CLIP; ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillStyle = LABEL_SCRIM;
    ctx.fillRect(tx - 4, y + 7, Math.min(room, nameWidth(ctx, name)) + 8, 15);
    ctx.fillStyle = LABEL_FG;
    ctx.fillText(name, tx, y + 9, room);
  }
}

const BADGE = ["V", "A"];
/** One track header in the lane whose top is `y`: kind chip + name, then (wide) the four switches or (compact) indicators of the ones that are on. */
function header(ctx: CanvasRenderingContext2D, scene: Scene, v: View, p: Palette, t: number, y: number, lifted: boolean) {
  const audio = scene.trackKind[t] === 1;
  const live = scene.trackLive[t] === 1;
  if (lifted) { ctx.fillStyle = p.line; ctx.fillRect(0, y, gut(v) - 1, LANE - 1); }
  // Kind chip.
  ctx.fillStyle = audio ? p.audioStrip : p.videoStrip;
  ctx.globalAlpha = live ? 1 : 0.5;
  ctx.fillRect(8, y + 7, 16, 16);
  ctx.fillStyle = p.bg;
  ctx.font = '700 10px Inter, system-ui, sans-serif';
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(BADGE[scene.trackKind[t]!]!, 16, y + 15.5);
  ctx.globalAlpha = 1;
  // Name.
  ctx.fillStyle = live ? p.fg : p.muted;
  ctx.font = FONT_HEAD;
  ctx.textAlign = "left";
  ctx.fillText(scene.trackName[t]!, 30, y + 15.5, gut(v) - (v.compact ? 48 : 38));
  if (v.compact) {
    // A small chevron: the whole header opens the track menu.
    const cx = gut(v) - 12, cy = y + 15.5;
    ctx.strokeStyle = p.muted; ctx.lineWidth = 1.5; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(cx - 3.5, cy - 1.8); ctx.lineTo(cx, cy + 1.8); ctx.lineTo(cx + 3.5, cy - 1.8); ctx.stroke();
    ctx.lineCap = "butt"; ctx.lineJoin = "miter";
    let x = IND.x0;
    for (const part of TOGGLES) {
      if (!state(scene, t, part)) continue; // (a video track that still carries an old mute shows it, so it is not invisible)
      glyph(ctx, p, part, x, y + IND.y, IND.size, true);
      x += IND.size + IND.gap;
    }
    return;
  }
  for (const part of togglesFor(scene.trackKind[t]!)) {
    const on = state(scene, t, part), x = switchX(TOGGLES.indexOf(part)), by = y + SW.y;
    if (on) { ctx.fillStyle = part === "lock" || part === "hide" ? p.fg : p.accent; ctx.fillRect(x, by, SW.w, SW.h); }
    else { ctx.strokeStyle = p.lineStrong; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, by + 0.5, SW.w - 1, SW.h - 1); }
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
