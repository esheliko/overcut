/** Flat, typed-array view of a Project's timeline for the canvas (ADR 0007, S8). Built once per project change, read every frame without allocating.
 *  Times here are SECONDS as floats, for drawing and hit-testing only; the model keeps integer ticks (ADR 0010). */
import type { Project } from "@app/engine-client";

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
}

export const EMPTY_SCENE: Scene = buildScene(null);

export function buildScene(project: Project | null, sequence = 0): Scene {
  const tracks = project?.sequences[sequence]?.tracks ?? [];
  const media = new Map<string, string>();
  for (const m of project?.media ?? []) media.set(m.id, m.name);
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
  };
  let i = 0;
  tracks.forEach((t, ti) => {
    scene.trackKind[ti] = t.kind === "audio" ? 1 : 0;
    scene.trackName.push(t.name);
    scene.trackFirst[ti] = i;
    // The model guarantees sorted, non-overlapping clips; sort anyway so a bad document cannot break the binary search.
    const clips = isSorted(t.clips) ? t.clips : [...t.clips].sort((a, b) => a.start - b.start);
    for (const c of clips) {
      scene.start[i] = c.start / TICKS_PER_SECOND;
      scene.end[i] = (c.start + c.duration) / TICKS_PER_SECOND;
      scene.name[i] = media.get(c.media) ?? c.media;
      scene.id[i] = c.id;
      if (scene.end[i]! > scene.endSec) scene.endSec = scene.end[i]!;
      i++;
    }
  });
  scene.trackFirst[tracks.length] = i;
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
