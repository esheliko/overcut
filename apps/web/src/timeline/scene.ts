/** Flat, typed-array view of a Project's timeline for the canvas (ADR 0007, S8). Built once per project change, read every frame without allocating.
 *  Times here are SECONDS as floats, for drawing and hit-testing only; the model keeps integer ticks (ADR 0010). */
import type { MediaRef, Project } from "@app/engine-client";
import { clipKeyTimes } from "../inspector/keyframeModel";

export const TICKS_PER_SECOND = 705_600_000;

export type TrackKind = "video" | "audio";

export interface Scene {
  trackCount: number;
  clipCount: number;
  /** Seconds covered by the last clip end (0 when empty). */
  endSec: number;
  trackKind: Uint8Array; // 0 video, 1 audio
  trackName: string[];
  /** Clips of track t are indices [trackFirst[t], trackFirst[t + 1]) of the arrays below, sorted by start. */
  trackFirst: Uint32Array;
  start: Float64Array;
  end: Float64Array;
  name: string[];
  id: string[];
  /** Exact integer ticks for building ops (a Float64 holds them exactly): start, duration, source_in, speed as a ratio, media length (0 = unknown). */
  tStart: Float64Array;
  tDur: Float64Array;
  tSrcIn: Float64Array;
  speedNum: Float64Array;
  speedDen: Float64Array;
  mediaDur: Float64Array;
  /** Per track: locked (1) or not (0), and the track id. */
  trackLocked: Uint8Array;
  trackId: string[];
  /** Per track: muted, soloed, hidden (1/0), and whether it takes part in the output given the solos of its kind (`trackLive`). */
  trackMuted: Uint8Array;
  trackSolo: Uint8Array;
  trackHidden: Uint8Array;
  trackLive: Uint8Array;
  /** Where each row sits in the model's track stack (0 = bottom), and the sequence the tracks belong to. Rows are shown top to bottom as
   *  the video tracks from the highest down, then the audio tracks from the first, so a track above another is composited over it. */
  trackModel: Uint16Array;
  sequenceId: string;
  /** Track index of each clip. */
  clipTrack: Uint16Array;
  /** Ticks per frame of the sequence (integer for every common rate). */
  frameTicks: number;
  /** Media id per clip, where in the media the clip starts (seconds), and the project's media by id (waveforms, thumbnails). */
  media: string[];
  srcIn: Float64Array;
  mediaById: Map<string, MediaRef>;
  /** Link id per clip ("" = alone) and, per link id, the indices of its clips (TL-05: linked clips are selected and edited together). */
  link: string[];
  linkGroups: Map<string, number[]>;
  /** Clip index -> absolute times (seconds) of its transform keyframes; only clips that have some. */
  keys: Map<number, number[]>;
}

export const EMPTY_SCENE: Scene = buildScene(null);

/** Model stack indices in display order: video tracks from the top of the stack down, then audio tracks bottom-up. */
export function displayOrder(tracks: readonly { kind: string }[]): number[] {
  const video: number[] = [], audio: number[] = [];
  tracks.forEach((t, i) => { if (t.kind === "audio") audio.push(i); else video.push(i); });
  return [...video.reverse(), ...audio];
}

export function buildScene(project: Project | null, sequence = 0): Scene {
  const stack = project?.sequences[sequence]?.tracks ?? [];
  const order = displayOrder(stack);
  const tracks = order.map((i) => stack[i]!);
  const media = new Map<string, string>();
  const mediaLen = new Map<string, number>();
  const mediaById = new Map<string, MediaRef>();
  for (const m of project?.media ?? []) { media.set(m.id, m.name); mediaById.set(m.id, m); if (m.duration) mediaLen.set(m.id, m.duration); }
  const rate = project?.sequences[sequence]?.frame_rate;
  let total = 0;
  for (const t of tracks) total += t.clips.length;
  const scene: Scene = {
    trackCount: tracks.length,
    clipCount: total,
    endSec: 0,
    trackKind: new Uint8Array(tracks.length),
    trackName: [],
    trackFirst: new Uint32Array(tracks.length + 1),
    start: new Float64Array(total),
    end: new Float64Array(total),
    name: new Array<string>(total),
    id: new Array<string>(total),
    tStart: new Float64Array(total),
    tDur: new Float64Array(total),
    tSrcIn: new Float64Array(total),
    speedNum: new Float64Array(total),
    speedDen: new Float64Array(total),
    mediaDur: new Float64Array(total),
    trackLocked: new Uint8Array(tracks.length),
    trackId: [],
    trackMuted: new Uint8Array(tracks.length),
    trackSolo: new Uint8Array(tracks.length),
    trackHidden: new Uint8Array(tracks.length),
    trackLive: new Uint8Array(tracks.length),
    trackModel: Uint16Array.from(order),
    sequenceId: project?.sequences[sequence]?.id ?? "",
    clipTrack: new Uint16Array(total),
    frameTicks: rate && rate.num > 0 ? Math.round((TICKS_PER_SECOND * rate.den) / rate.num) : TICKS_PER_SECOND / 30,
    media: new Array<string>(total),
    srcIn: new Float64Array(total),
    mediaById,
    link: new Array<string>(total),
    linkGroups: new Map(),
    keys: new Map(),
  };
  let i = 0;
  tracks.forEach((t, ti) => {
    scene.trackKind[ti] = t.kind === "audio" ? 1 : 0;
    scene.trackName.push(t.name);
    scene.trackId.push(t.id);
    scene.trackLocked[ti] = t.locked ? 1 : 0;
    scene.trackMuted[ti] = t.muted ? 1 : 0;
    scene.trackSolo[ti] = t.solo ? 1 : 0;
    scene.trackHidden[ti] = t.hidden ? 1 : 0;
    scene.trackFirst[ti] = i;
    // The model guarantees sorted, non-overlapping clips; sort anyway so a bad document cannot break the binary search.
    const clips = isSorted(t.clips) ? t.clips : [...t.clips].sort((a, b) => a.start - b.start);
    for (const c of clips) {
      scene.start[i] = c.start / TICKS_PER_SECOND;
      scene.end[i] = (c.start + c.duration) / TICKS_PER_SECOND;
      scene.name[i] = media.get(c.media) ?? c.media;
      scene.id[i] = c.id;
      scene.clipTrack[i] = ti;
      scene.tStart[i] = c.start;
      scene.tDur[i] = c.duration;
      scene.tSrcIn[i] = c.source_in;
      scene.speedNum[i] = c.speed?.num ?? 1;
      scene.speedDen[i] = c.speed?.den ?? 1;
      scene.mediaDur[i] = mediaLen.get(c.media) ?? 0;
      scene.media[i] = c.media;
      scene.link[i] = c.link ?? "";
      if (c.link) { const g = scene.linkGroups.get(c.link); if (g) g.push(i); else scene.linkGroups.set(c.link, [i]); }
      scene.srcIn[i] = c.source_in / TICKS_PER_SECOND;
      if (c.transform) { const kt = clipKeyTimes(c); if (kt.length) scene.keys.set(i, kt.map((k) => k / TICKS_PER_SECOND)); }
      if (scene.end[i]! > scene.endSec) scene.endSec = scene.end[i]!;
      i++;
    }
  });
  scene.trackFirst[tracks.length] = i;
  // Live = not muted, not hidden, and (when some track of the same kind is soloed) soloed itself; the engine's own rule (`Track::is_live`).
  const soloed = [false, false];
  for (let t = 0; t < tracks.length; t++) if (scene.trackSolo[t]) soloed[scene.trackKind[t]!] = true;
  for (let t = 0; t < tracks.length; t++) scene.trackLive[t] = !scene.trackMuted[t] && !scene.trackHidden[t] && (!soloed[scene.trackKind[t]!] || scene.trackSolo[t]) ? 1 : 0;
  return scene;
}

function isSorted(clips: { start: number }[]): boolean {
  for (let i = 1; i < clips.length; i++) if (clips[i]!.start < clips[i - 1]!.start) return false;
  return true;
}

/** First clip index in [lo, hi) whose end is > sec (clips are sorted and non-overlapping, so ends are sorted too). */
export function firstEndingAfter(scene: Scene, lo: number, hi: number, sec: number): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (scene.end[mid]! > sec) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
