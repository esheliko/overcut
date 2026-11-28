/** The volume line and the fade handles on an audio clip (`docs/features/clip-audio.md`): where they are drawn, what a pointer at (x, y) grabs, and how a drag
 *  turns into a value. Pure and allocation-free except for the one record a gesture keeps. The painter (`audioDraw.ts`) and the pointer rules (`interact.ts`) share this. */
import type { Op } from "@app/engine-client";
import { maxFadeTicks, clampAudio, percent, seconds, toAudio, MAX_VOLUME, SNAP_VOLUME, TICKS, type AudioValues } from "../inspector/audioModel";
import { clipAtTime, trackAtY } from "./hit";
import type { Scene } from "./scene";
import { gut, LANE, RULER, xToTime, type View } from "./view";

/** The line's travel inside a lane (px from the lane top): 200% at the top, silence at the bottom, 100% in the middle. */
export const LINE_TOP = 12;
export const LINE_BOT = 50;
/** Fade handles sit on the clip's top edge. */
export const HANDLE_Y = 3;
/** Narrower than this a clip shows no volume line; narrower than `HANDLES_MIN_W` no fade handles. */
export const LINE_MIN_W = 40;
export const HANDLES_MIN_W = 80;
/** Grab radius (px): a mouse is precise, a finger is not (44 px targets). */
const RADIUS = { mouse: 9, touch: 22 };
const BAND = { mouse: 6, touch: 14 };

export type AudioPart = "vol" | "in" | "out";

/** Pixel y of volume `vol` in the lane whose top is `laneY`. */
export const levelY = (laneY: number, vol: number): number => laneY + LINE_BOT - (Math.min(MAX_VOLUME, Math.max(0, vol)) / MAX_VOLUME) * (LINE_BOT - LINE_TOP);

/** What the pointer is over on a selected audio clip: the line, or a fade handle, or null. Handles win over the line where they overlap. */
export function audioHit(scene: Scene, v: View, selected: Uint8Array, x: number, y: number, touch: boolean): { clip: number; part: AudioPart } | null {
  const track = trackAtY(scene, v, y);
  if (track < 0 || x < gut(v) || scene.trackKind[track] !== 1 || scene.trackLocked[track]) return null;
  const laneY = RULER + track * LANE - v.scrollY;
  const rad = touch ? RADIUS.touch : RADIUS.mouse;
  // The handle of a neighbour can reach into this clip's area (its radius), so look at the clip under the pointer and at the ones next to it.
  const at = clipAtTime(scene, track, xToTime(v, x));
  const lo = scene.trackFirst[track]!, hi = scene.trackFirst[track + 1]!;
  for (let i = Math.max(lo, (at < 0 ? lo : at) - 1); i < hi && i <= (at < 0 ? lo : at) + 1; i++) {
    if (!selected[i]) continue;
    const x0 = gut(v) + scene.start[i]! * v.pps - v.scrollX + 1;
    const w = (scene.end[i]! - scene.start[i]!) * v.pps - 2;
    if (w < LINE_MIN_W) continue;
    if (w >= HANDLES_MIN_W && y >= laneY - rad / 2 && y <= laneY + HANDLE_Y + rad) {
      const fi = Math.min(w / 2, (scene.tFadeIn[i]! / TICKS) * v.pps), fo = Math.min(w / 2, (scene.tFadeOut[i]! / TICKS) * v.pps);
      const dIn = Math.hypot(x - (x0 + fi), y - (laneY + HANDLE_Y)), dOut = Math.hypot(x - (x0 + w - fo), y - (laneY + HANDLE_Y));
      if (dIn <= rad && dIn <= dOut) return { clip: i, part: "in" };
      if (dOut <= rad) return { clip: i, part: "out" };
    }
    if (x >= x0 && x <= x0 + w && Math.abs(y - levelY(laneY, scene.volume[i]!)) <= (touch ? BAND.touch : BAND.mouse)) return { clip: i, part: "vol" };
  }
  return null;
}

/** A drag in progress: the values the clip had and the values now (volume, fades in ticks). */
export interface AudioDrag { part: AudioPart; clip: number; sx: number; sy: number; from: AudioValues; to: AudioValues; /** The pointer has travelled past the slop: before that a press on the line is only a press (a finger wobbles). */ moved: boolean }

export const startAudioDrag = (scene: Scene, hit: { clip: number; part: AudioPart }, x: number, y: number): AudioDrag => {
  const from: AudioValues = { volume: scene.volume[hit.clip]!, fadeIn: scene.tFadeIn[hit.clip]!, fadeOut: scene.tFadeOut[hit.clip]! };
  return { part: hit.part, clip: hit.clip, sx: x, sy: y, from, to: from, moved: false };
};

/** The values after the pointer moved to (x, y): the line follows the pointer vertically (clicking onto 100% when it comes near), a fade handle horizontally. */
export function dragAudio(scene: Scene, d: AudioDrag, v: View, x: number, y: number, slop: number): AudioDrag {
  if (!d.moved && Math.hypot(x - d.sx, y - d.sy) <= slop) return d;
  const dur = scene.tDur[d.clip]!;
  let to: AudioValues;
  if (d.part === "vol") {
    let vol = d.from.volume + ((d.sy - y) / (LINE_BOT - LINE_TOP)) * MAX_VOLUME;
    if (Math.abs(vol - 1) <= SNAP_VOLUME) vol = 1;
    to = clampAudio({ ...d.from, volume: vol }, dur);
  } else {
    const delta = ((x - d.sx) / v.pps) * TICKS * (d.part === "in" ? 1 : -1);
    const key = d.part === "in" ? "fadeIn" : "fadeOut";
    to = clampAudio({ ...d.from, [key]: Math.min(maxFadeTicks(dur), d.from[key] + delta) }, dur);
  }
  return { ...d, to, moved: true };
}

/** The one op that commits a drag (null when nothing changed). */
export function audioDragOps(scene: Scene, d: AudioDrag): Op[] | null {
  const dur = scene.tDur[d.clip]!;
  const to = clampAudio(d.to, dur), from = clampAudio(d.from, dur);
  if (to.volume === from.volume && to.fadeIn === from.fadeIn && to.fadeOut === from.fadeOut) return null;
  return [{ op: "set_clip_audio", clip: scene.id[d.clip]!, audio: toAudio(to) }];
}

/** What a drag says to a screen reader / the status line. */
export function audioSay(scene: Scene, d: AudioDrag): { key: string; values: Record<string, string | number> } {
  const name = scene.name[d.clip]!;
  if (d.part === "vol") return { key: "timeline.say.volume", values: { name, percent: percent(d.to.volume) } };
  return { key: d.part === "in" ? "timeline.say.fadeIn" : "timeline.say.fadeOut", values: { name, seconds: seconds(d.part === "in" ? d.to.fadeIn : d.to.fadeOut) } };
}
