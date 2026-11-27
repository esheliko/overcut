import type { ColourInfo } from "../types";

// Names are WebCodecs' (the DOM typings list only the SDR ones, hence strings and the casts below).
const PRIMARIES: Partial<Record<number, string>> = { 1: "bt709", 5: "bt470bg", 6: "smpte170m", 9: "bt2020", 12: "smpte432" };
const TRANSFER: Partial<Record<number, string>> = { 1: "bt709", 6: "smpte170m", 13: "iec61966-2-1", 16: "pq", 18: "hlg" };
const MATRIX: Partial<Record<number, string>> = { 0: "rgb", 1: "bt709", 5: "bt470bg", 6: "smpte170m", 9: "bt2020-ncl" };

/**
 * The container's colour description (ISO 23001-8 code points, as the probe reports them) as WebCodecs' `VideoColorSpaceInit`, for
 * `VideoDecoderConfig.colorSpace`. Without it a decoder reads a full-range picture (our own exports, most screen recordings) as limited range
 * and stretches the levels. Unknown or unspecified code points are left out so the decoder keeps deciding those itself; `undefined` = nothing declared.
 */
export function colourSpaceInit(c: ColourInfo | null | undefined): VideoColorSpaceInit | undefined {
  if (!c) return undefined;
  const primaries = PRIMARIES[c.primaries];
  const transfer = TRANSFER[c.transfer];
  const matrix = MATRIX[c.matrix];
  const out: VideoColorSpaceInit = {};
  if (primaries) out.primaries = primaries as VideoColorPrimaries;
  if (transfer) out.transfer = transfer as VideoTransferCharacteristics;
  if (matrix && c.matrix !== 0) out.matrix = matrix as VideoMatrixCoefficients; // 0 = "identity/rgb" is not a YUV description: ignore it
  if (c.fullRange != null) out.fullRange = c.fullRange;
  return Object.keys(out).length ? out : undefined;
}
