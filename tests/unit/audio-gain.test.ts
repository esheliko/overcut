import test from "node:test";
import assert from "node:assert/strict";
import { segmentGain, type AudioSegment } from "../../packages/engine-client/src/index";
import { AudioMixer } from "../../packages/engine-client/src/export/audio-mix";
import { mixSegment, mixStretched } from "../../apps/web/src/preview/audioMix";

/** The segment `crates/timeline` produces for a 1 s clip at 48 kHz with volume 2, fade in 0.1 s and fade out 0.25 s (evaluate.rs test). */
const seg: AudioSegment = {
  track: "a", clip: "c", media: "m", out_start: 0, len: 48_000, source_start: 0, speed: { num: 1, den: 1 },
  gain: 2, fade_in: 4800, fade_out: 12_000, clip_len: 48_000, clip_source_in: 0, clip_source_len: 0, clip_offset: 0,
};

test("segmentGain gives the values the engine's AudioSegment::gain_at gives (linear ramps, volume on top)", () => {
  const at = (i: number) => segmentGain(seg, i);
  assert.equal(at(0), 0);
  assert.equal(at(2400), 1);
  assert.equal(at(4800), 2);
  assert.equal(at(30_000), 2);
  assert.equal(at(48_000 - 12_000 - 1), 2);
  assert.ok(Math.abs(at(48_000 - 6_001) - 1) < 1e-3);
  assert.equal(at(47_999), 0);
  // a window that starts inside the clip sees the same envelope (clip_offset)
  assert.equal(segmentGain({ ...seg, clip_offset: 2400 }, 0), 1);
  // no fades: the volume alone, whatever the clip length
  assert.equal(segmentGain({ ...seg, fade_in: 0, fade_out: 0, clip_len: 0 }, 5), 2);
});

/** Preview mixes, the exporter mixes: the same segment must come out sample for sample the same, volume and fades included. */
test("preview and export apply the same volume and fades", async () => {
  const frames = 48_000;
  const src = new Float32Array(frames);
  for (let i = 0; i < frames; i++) src[i] = Math.sin(i / 50) * 0.4;
  const media = {
    read: async (_start: number, count: number, out: Float32Array[]) => {
      for (const ch of out) ch.set(src.subarray(0, count));
    },
    close: () => undefined,
  };
  const exported = new Float32Array(frames * 2);
  await new AudioMixer(48_000, async () => media).mix({ time: 0, frame: 0, video_time: 0, sample: 0, audio_samples: frames, layers: [], audio: [seg] }, frames, exported);

  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  mixSegment(left, right, seg, src, 1);
  for (let i = 0; i < frames; i++) {
    // The exporter clamps to [-1, 1]; the preview limiter only rounds off what goes over, which this signal (peak 0.8) never does.
    assert.equal(exported[i], left[i], `left ${i}`);
    assert.equal(exported[frames + i], right[i], `right ${i}`);
  }
  const stretchedLeft = new Float32Array(frames);
  const stretchedRight = new Float32Array(frames);
  mixStretched(stretchedLeft, stretchedRight, seg, [src], 0);
  assert.deepEqual(stretchedLeft, left);
  assert.deepEqual(stretchedRight, right);
  // and the level really is what the settings say: silent at the very start and end, 2x in the middle
  assert.equal(left[0], 0);
  assert.equal(left[frames - 1], 0);
  assert.equal(left[20_000], src[20_000]! * 2);
});
