/** Deterministic sample projects for the timeline view (no media loaded yet) and for the S8 benchmark. */
import type { Clip, MediaRef, Project, Track } from "@app/engine-client";
import { TICKS_PER_SECOND } from "./scene";

const hex = (n: number) => n.toString(16).padStart(32, "0");

export interface FixtureOptions {
  /** Alternating video, audio, video... */
  tracks: number;
  clipsPerTrack: number;
  /** Clip length in seconds; gaps are a quarter of it. */
  clipSec?: number;
}

export function fixtureProject({ tracks, clipsPerTrack, clipSec = 4 }: FixtureOptions): Project {
  const media: MediaRef[] = [];
  const out: Track[] = [];
  let id = 1;
  for (let t = 0; t < tracks; t++) {
    const kind = t % 2 === 0 ? "video" : "audio";
    const mid = hex(id++);
    media.push({ id: mid, kind, name: `${kind === "video" ? "Clip" : "Audio"} ${t + 1}`, uri: `fixture:${t}` });
    const clips: Clip[] = [];
    let at = 0;
    for (let c = 0; c < clipsPerTrack; c++) {
      // Vary lengths a little so rectangles are not uniform.
      const len = clipSec * (0.6 + ((c * 7 + t * 3) % 9) / 10);
      const duration = Math.round(len * TICKS_PER_SECOND);
      clips.push({ id: hex(id++), media: mid, start: at, source_in: 0, duration });
      at += duration + Math.round((clipSec / 4) * TICKS_PER_SECOND);
    }
    out.push({ id: hex(id++), kind, name: `${kind === "video" ? "V" : "A"}${Math.floor(t / 2) + 1}`, clips, locked: false, muted: false });
  }
  return {
    id: hex(id++), name: "Sample", schema_version: 4, media,
    sequences: [{ id: hex(id++), name: "Main", frame_rate: { num: 30, den: 1 }, resolution: { width: 1920, height: 1080 }, sample_rate: 48000, tracks: out }],
  };
}

/** One video and one audio track, a handful of clips over ~40 s: what the editor shows before media is imported. */
export const sampleProject = (): Project => fixtureProject({ tracks: 2, clipsPerTrack: 7, clipSec: 5 });

/** About two hours on two tracks (`?sample=2h`): what the smoke test zooms out over. */
export const longSampleProject = (): Project => fixtureProject({ tracks: 2, clipsPerTrack: 1150, clipSec: 5 });
