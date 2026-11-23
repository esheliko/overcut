import type { Rational, Resolution } from "@app/engine-client";

/** Canvas sizes offered by the New project sheet (PM-01). `match` is not a size: the first picture sets it (the default). */
export const CANVAS_PRESETS = [
  { id: "16:9", width: 1920, height: 1080 },
  { id: "9:16", width: 1080, height: 1920 },
  { id: "1:1", width: 1080, height: 1080 },
  { id: "4:5", width: 1080, height: 1350 },
  { id: "4k", width: 3840, height: 2160 },
] as const;
export type PresetId = (typeof CANVAS_PRESETS)[number]["id"];

/** The aspect ratios the preview picker offers (4K is the same shape as 16:9). */
export const RATIO_IDS = ["16:9", "9:16", "1:1", "4:5"] as const;
export type RatioId = (typeof RATIO_IDS)[number];

export const FRAME_RATES = [24, 25, 30, 50, 60] as const;

export const presetSize = (id: PresetId): Resolution => {
  const p = CANVAS_PRESETS.find((x) => x.id === id)!;
  return { width: p.width, height: p.height };
};

export const rateOf = (fps: number): Rational => ({ num: fps, den: 1 });

/** The picker entry whose shape is closest to this canvas. */
export function nearestRatio(res: Resolution): RatioId {
  const a = res.width / res.height;
  let best: RatioId = "16:9";
  let diff = Infinity;
  for (const id of RATIO_IDS) {
    const p = CANVAS_PRESETS.find((x) => x.id === id)!;
    const d = Math.abs(Math.log(p.width / p.height / a));
    if (d < diff) {
      diff = d;
      best = id;
    }
  }
  return best;
}
