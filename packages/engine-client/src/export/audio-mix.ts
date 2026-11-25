import type { FrameDescription } from "../types";
import type { MediaAudio } from "./media";
import { sourceSample } from "./media";
import { ClipStretchCache, type Stretcher } from "../audio-stretch";

export const CHANNELS = 2;

/**
 * Sums the audio segments of one `evaluate` window into `out` (planar: channel 0 then channel 1, `frames` samples each, already zeroed).
 * Segments come from the engine (position, source start, speed, gain); decoding is the host's `MediaAudio`.
 * Speed other than 1 plays the clip's pre-stretched audio (pitch kept, `ClipStretchCache`); without a stretcher, or for a clip too long to
 * hold, it picks the nearest source sample (pitch shifts). The result is clamped to [-1, 1].
 */
export class AudioMixer {
  private planar: Float32Array[] = [new Float32Array(0), new Float32Array(0)];

  private readonly stretched?: ClipStretchCache;

  constructor(
    private readonly rate: number,
    private readonly audioOf: (mediaId: string) => Promise<MediaAudio | undefined>,
    stretch?: Stretcher,
  ) {
    if (stretch) {
      this.stretched = new ClipStretchCache(rate, stretch, async (id, start, count) => {
        const planar = [new Float32Array(count), new Float32Array(count)];
        await (await this.audioOf(id))?.read(start, count, planar);
        return planar;
      });
    }
  }

  async mix(desc: FrameDescription, frames: number, out: Float32Array): Promise<void> {
    for (const seg of desc.audio) {
      const media = await this.audioOf(seg.media);
      if (!media || seg.len <= 0) continue;
      const num = seg.speed.num;
      const den = seg.speed.den;
      const clip = num === den ? null : await this.stretched?.get(seg);
      if (clip) {
        for (let c = 0; c < CHANNELS; c++) {
          const src = clip[c] ?? clip[0]!;
          const base = c * frames + seg.out_start;
          for (let j = 0; j < seg.len; j++) out[base + j] = (out[base + j] ?? 0) + (src[seg.clip_offset + j] ?? 0) * seg.gain;
        }
        continue;
      }
      const span = Math.ceil((seg.len * num) / den) + 1;
      if (this.planar[0]!.length < span) this.planar = [new Float32Array(span), new Float32Array(span)];
      await media.read(sourceSample(seg.source_start, this.rate), span, this.planar);
      for (let c = 0; c < CHANNELS; c++) {
        const src = this.planar[c]!;
        const base = c * frames + seg.out_start;
        for (let j = 0; j < seg.len; j++) {
          const v = src[num === den ? j : Math.floor((j * num) / den)] ?? 0;
          out[base + j] = (out[base + j] ?? 0) + v * seg.gain;
        }
      }
    }
    for (let i = 0; i < out.length; i++) {
      const v = out[i] ?? 0;
      if (v > 1) out[i] = 1;
      else if (v < -1) out[i] = -1;
    }
  }
}
