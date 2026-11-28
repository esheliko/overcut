/** Gaps in the picture: stretches of the timeline (from 0 to the last clip end) where no video clip plays, so the export shows black there (UX r15).
 *  Pure; the canvas draws them hatched and the export dialog asks `gapSummary` for a count. Times are seconds. */
import type { Project } from "@app/engine-client";
import { buildScene, TICKS_PER_SECOND, type Scene } from "./scene";

export interface Gap { start: number; end: number }

const cache = new WeakMap<Scene, Gap[]>();

/** Gaps of the picture, in seconds, in time order. A project with no video clip has no gap (a sound-only project is not black by mistake). */
export function pictureGaps(scene: Scene): Gap[] {
  const hit = cache.get(scene);
  if (hit) return hit;
  const spans: Gap[] = [];
  for (let t = 0; t < scene.trackCount; t++) {
    if (scene.trackKind[t] !== 0 || scene.trackHidden[t]) continue;
    for (let i = scene.trackFirst[t]!; i < scene.trackFirst[t + 1]!; i++) spans.push({ start: scene.start[i]!, end: scene.end[i]! });
  }
  const out: Gap[] = [];
  if (spans.length > 0) {
    spans.sort((a, b) => a.start - b.start);
    const eps = scene.frameTicks / TICKS_PER_SECOND / 2; // half a frame: float noise is not a gap
    let reach = 0;
    for (const s of spans) {
      if (s.start - reach > eps) out.push({ start: reach, end: s.start });
      if (s.end > reach) reach = s.end;
    }
    if (scene.endSec - reach > eps) out.push({ start: reach, end: scene.endSec }); // sound that outlasts the picture
  }
  cache.set(scene, out);
  return out;
}

/** What the export dialog needs: how many gaps and how many seconds of black they add up to. */
export function gapSummary(scene: Scene): { count: number; seconds: number } {
  const g = pictureGaps(scene);
  return { count: g.length, seconds: g.reduce((a, x) => a + (x.end - x.start), 0) };
}
/** The same for a project (sequence 0), for callers that hold no scene (the export dialog). */
export const projectGapSummary = (project: Project | null): { count: number; seconds: number } => gapSummary(buildScene(project));
