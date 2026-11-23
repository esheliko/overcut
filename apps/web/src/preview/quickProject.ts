/** A one-clip project from a freshly opened file: the sequence takes the clip's display size and frame rate (until the media bin, M1-032, builds projects). */
import type { MediaFileInfo, Project } from "@app/engine-client";
import { displaySize } from "./layout";

const hex32 = (): string => {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
};

const STANDARD: [number, number][] = [[24000, 1001], [24, 1], [25, 1], [30000, 1001], [30, 1], [50, 1], [60000, 1001], [60, 1]];

/** Nearest standard frame rate to the clip's (VFR clips and odd rates map to the closest, 30 if unknown). */
export function sequenceRate(fps: { num: number; den: number } | undefined): { num: number; den: number } {
  if (!fps || fps.den <= 0 || fps.num <= 0) return { num: 30, den: 1 };
  const v = fps.num / fps.den;
  let best = STANDARD[0]!;
  for (const s of STANDARD) if (Math.abs(s[0] / s[1] - v) < Math.abs(best[0] / best[1] - v)) best = s;
  return { num: best[0], den: best[1] };
}

export function quickProject(name: string, info: MediaFileInfo, uri: string): Project {
  const media = hex32();
  const v = info.video;
  const disp = v ? displaySize(v.width, v.height, v.rotation) : { width: 1920, height: 1080 };
  // Even sizes, like every encoder expects.
  const resolution = { width: Math.max(2, disp.width & ~1), height: Math.max(2, disp.height & ~1) };
  const clip = (): Project["sequences"][number]["tracks"][number]["clips"] => [{ id: hex32(), media, start: 0, source_in: 0, duration: info.durationTicks }];
  const tracks: Project["sequences"][number]["tracks"] = [];
  if (v) tracks.push({ id: hex32(), kind: "video", name: "V1", clips: clip(), locked: false, muted: false });
  if (info.audio) tracks.push({ id: hex32(), kind: "audio", name: "A1", clips: clip(), locked: false, muted: false });
  return {
    id: hex32(), name, schema_version: 1,
    media: [{ id: media, kind: v ? "video" : "audio", name, uri, duration: info.durationTicks }],
    sequences: [{ id: hex32(), name: "Main", frame_rate: sequenceRate(v?.fps), resolution, sample_rate: 48_000, tracks }],
  };
}
