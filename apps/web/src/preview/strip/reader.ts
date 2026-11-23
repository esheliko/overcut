/** Reads stand-in pictures out of a built strip. Two segments stay in memory (a scrub moves through neighbours), everything else is one cache read away. */
import type { MediaCache } from "../../media/cache";
import { nearestStored, type StripSpec } from "./policy";
import { segmentKey, segmentOf, unpackSegment, type Manifest, type Segment } from "./store";

/** `index` = the source frame this picture shows (the stored frame nearest to the one asked for). */
export interface StripPic { bitmap: ImageBitmap; width: number; height: number; index: number }

export class StripReader {
  private recent: { seg: number; data: Segment }[] = [];

  constructor(private cache: () => MediaCache, private base: string, private spec: StripSpec, private frames: number, private manifest: Manifest) {}

  /** True when the segment holding `index` is built, so `picture(index)` can answer. */
  covers(index: number): boolean { return this.manifest.done.includes(segmentOf(nearestStored(index, this.spec.stride, this.frames), this.spec)); }

  private async segment(seg: number): Promise<Segment | undefined> {
    const hit = this.recent.find((r) => r.seg === seg);
    if (hit) return hit.data;
    const bytes = await this.cache().get(segmentKey(this.base, seg));
    const data = bytes ? unpackSegment(bytes) : null;
    if (!data) {
      const at = this.manifest.done.indexOf(seg);
      if (at >= 0) this.manifest.done.splice(at, 1); // evicted or unreadable: not done any more
      return undefined;
    }
    this.recent.unshift({ seg, data });
    this.recent.length = Math.min(this.recent.length, 2);
    return data;
  }

  /** The stored frame nearest to `index` as an upright-as-coded bitmap (the caller applies the clip's display rotation), or undefined when it is not built. */
  async picture(index: number): Promise<StripPic | undefined> {
    const stored = nearestStored(index, this.spec.stride, this.frames);
    const seg = segmentOf(stored, this.spec);
    if (!this.manifest.done.includes(seg)) return undefined;
    const data = await this.segment(seg);
    const jpeg = data?.jpeg(Math.round((stored - data.first) / data.stride));
    if (!jpeg) return undefined;
    const bitmap = await createImageBitmap(new Blob([jpeg as BlobPart], { type: "image/jpeg" }));
    return { bitmap, width: bitmap.width, height: bitmap.height, index: stored };
  }

  clear(): void { this.recent = []; }
}
