/**
 * Pitch-keeping clip speed for audio (`docs/features/speed.md`). The Rust stretcher (`app_audio::stretch`, WSOLA) turns a clip's whole source
 * window into its timeline length once; mixers then read the result like speed-1 audio. Preview and export share this file, so what you
 * hear is what you export.
 */
import type { AudioSegment } from "./types";
import { TICKS_PER_SECOND } from "./export/plan";

/** Stretches planar channels by `num/den` (> 1 = faster = shorter) at `rate`; the pitch stays. The wasm module's `stretch_audio`. */
export type Stretcher = (planar: Float32Array[], rate: number, num: number, den: number) => Float32Array[];

/** Longest source window stretched in one piece (memory: ~2 copies x channels x 4 bytes x samples). Longer clips fall back to resampling. */
export const MAX_STRETCH_SECONDS = 300;

type SegmentClip = Pick<AudioSegment, "clip" | "media" | "speed" | "clip_source_in" | "clip_source_len">;

const toSamples = (ticks: number, rate: number): number => Number((BigInt(Math.max(0, Math.trunc(ticks))) * BigInt(rate)) / TICKS_PER_SECOND);

/** Reads `count` samples of `media` from `start` at the sequence rate as `channels` planar arrays (silence past the end). */
export type ReadPlanar = (media: string, start: number, count: number) => Promise<Float32Array[]>;

export class ClipStretchCache {
  private readonly entries = new Map<string, Promise<Float32Array[] | null>>();

  constructor(
    private readonly rate: number,
    private readonly stretcher: Stretcher,
    private readonly read: ReadPlanar,
    private readonly keep = 3,
  ) {}

  /** The clip's audio stretched to its timeline length (index 0 = the clip's first sample), or null when it is too long to hold. */
  get(seg: SegmentClip): Promise<Float32Array[] | null> {
    const key = `${seg.clip}|${seg.clip_source_in}|${seg.clip_source_len}|${seg.speed.num}/${seg.speed.den}`;
    let hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key); // most recently used goes last
    } else {
      hit = this.build(seg);
    }
    this.entries.set(key, hit);
    while (this.entries.size > this.keep) this.entries.delete(this.entries.keys().next().value as string);
    return hit;
  }

  private async build(seg: SegmentClip): Promise<Float32Array[] | null> {
    const count = toSamples(seg.clip_source_len, this.rate);
    if (count <= 0 || count > MAX_STRETCH_SECONDS * this.rate) return null;
    const src = await this.read(seg.media, toSamples(seg.clip_source_in, this.rate), count);
    const len = src[0]?.length ?? 0;
    const planar = src.map((c) => c.subarray(0, len));
    const out = this.stretcher(planar, this.rate, seg.speed.num, seg.speed.den);
    return out.length ? out : [new Float32Array(0), new Float32Array(0)];
  }
}
