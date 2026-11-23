import type { Project, Sequence } from "../model.generated";
import { ExportError, type ExportSettings } from "./types";

export const TICKS_PER_SECOND = 705_600_000n;

/** Everything the loop needs, fixed up front from the project and the settings. All time maths is integer (ADR 0010). */
export interface ExportPlan {
  sequence: Sequence;
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  sampleRate: number;
  /** First sequence frame exported. */
  startFrame: number;
  /** Frames to encode. */
  totalFrames: number;
  /** Audio samples to encode (`round(totalFrames / fps * sampleRate)`). */
  totalSamples: number;
  keyframeEvery: number;
}

export const evenDown = (n: number): number => Math.max(2, Math.floor(n / 2) * 2);

/** Ticks at the start of sequence frame `index`: `floor(index * TICKS * den / num)`, exact in BigInt. */
export function frameTicks(index: number, fpsNum: number, fpsDen: number): number {
  return Number((BigInt(index) * TICKS_PER_SECOND * BigInt(fpsDen)) / BigInt(fpsNum));
}

/** Ticks at the start of audio sample `index` for `rate` Hz (same rule as `Time::from_sample_index`). */
export function sampleTicks(index: number, rate: number): number {
  return Number((BigInt(index) * TICKS_PER_SECOND) / BigInt(rate));
}

/** Microseconds of sequence frame `index` (round to nearest; the encoders and the muxer both see exactly this). */
export function frameMicros(index: number, fpsNum: number, fpsDen: number): number {
  return Number((BigInt(index) * 1_000_000n * BigInt(fpsDen) * 2n + BigInt(fpsNum)) / (BigInt(fpsNum) * 2n));
}

export function sampleMicros(index: number, rate: number): number {
  return Number((BigInt(index) * 1_000_000n * 2n + BigInt(rate)) / (BigInt(rate) * 2n));
}

/** The end of the last clip in the sequence, in ticks. 0 for an empty sequence. */
export function sequenceEnd(seq: Sequence): number {
  let end = 0;
  for (const t of seq.tracks) for (const c of t.clips) end = Math.max(end, c.start + c.duration);
  return end;
}

export function planExport(project: Project, settings: ExportSettings): ExportPlan {
  const sequence = project.sequences.find((s) => s.id === settings.sequence);
  if (!sequence) throw new ExportError("invalid_settings", `The project has no sequence "${settings.sequence}".`);
  const { num: fpsNum, den: fpsDen } = settings.frameRate ?? sequence.frame_rate;
  if (!(Number.isInteger(fpsNum) && Number.isInteger(fpsDen) && fpsNum > 0 && fpsDen > 0 && fpsNum / fpsDen <= 240)) throw new ExportError("invalid_settings", "The sequence has an invalid frame rate.");
  const endTicks = sequenceEnd(sequence);
  const seqFrames = Number((BigInt(endTicks) * BigInt(fpsNum) + TICKS_PER_SECOND * BigInt(fpsDen) - 1n) / (TICKS_PER_SECOND * BigInt(fpsDen)));
  const startFrame = settings.range?.startFrame ?? 0;
  const endFrame = settings.range?.endFrame ?? seqFrames;
  if (seqFrames === 0 && !settings.range) throw new ExportError("empty_sequence", "The sequence is empty: there is nothing to export.");
  if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) || startFrame < 0 || endFrame <= startFrame) {
    throw new ExportError("invalid_settings", "The export range is empty or invalid.");
  }
  const totalFrames = endFrame - startFrame;
  const width = evenDown(settings.width ?? sequence.resolution.width);
  const height = evenDown(settings.height ?? sequence.resolution.height);
  if (width > 8192 || height > 8192) throw new ExportError("invalid_settings", "The output size is larger than 8192 pixels.");
  const sampleRate = sequence.sample_rate;
  const totalSamples = Number((BigInt(totalFrames) * BigInt(sampleRate) * BigInt(fpsDen) * 2n + BigInt(fpsNum)) / (BigInt(fpsNum) * 2n));
  const fps = fpsNum / fpsDen;
  const keyframeEvery = Math.max(1, Math.round((settings.keyframeIntervalSeconds ?? 2) * fps));
  return { sequence, width, height, fpsNum, fpsDen, sampleRate, startFrame, totalFrames, totalSamples, keyframeEvery };
}
