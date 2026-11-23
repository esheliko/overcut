/** Layer geometry for the compositor: display rotation from the probe, sizes, texture mapping. Pure, unit-tested. */
export type Rotation = 0 | 90 | 180 | 270;

export const normalizeRotation = (deg: number): Rotation => ((((Math.round(deg / 90) * 90) % 360) + 360) % 360) as Rotation;

/** Size as displayed (width and height swap for 90 and 270). */
export function displaySize(width: number, height: number, rotation: number): { width: number; height: number } {
  const r = normalizeRotation(rotation);
  return r === 90 || r === 270 ? { width: height, height: width } : { width, height };
}

/**
 * 2x2 matrix `[a, b, c, d]` (row major) taking a point `q` in the unit display square (centred, -0.5..0.5, y down) to its position in
 * the coded image (centred), i.e. rotation by `-rotation` clockwise. Exact for the four right angles (no float noise at the seams).
 * A frame whose probe says `rotation = 90` is stored sideways; displaying it clockwise-rotated by 90 makes a portrait phone clip upright.
 */
export function textureMatrix(rotation: number): [number, number, number, number] {
  switch (normalizeRotation(rotation)) {
    case 0: return [1, 0, 0, 1];
    case 90: return [0, 1, -1, 0];
    case 180: return [-1, 0, 0, -1];
    case 270: return [0, -1, 1, 0];
  }
}

/** Apply `textureMatrix` to a point (tests, and the CPU fallback). */
export function mapToCoded(rotation: number, x: number, y: number): [number, number] {
  const [a, b, c, d] = textureMatrix(rotation);
  return [a * x + b * y, c * x + d * y];
}

export interface PlacedLayer {
  /** Layer centre in sequence pixels. */
  cx: number;
  cy: number;
  /** Half extents in sequence pixels, after scale. */
  hw: number;
  hh: number;
}

/** Where a layer lands in sequence pixels: `scale` multiplies the display-oriented pixel size (same meaning as `app_render::Layer`). */
export function placeLayer(display: { width: number; height: number }, center: [number, number], scale: [number, number]): PlacedLayer {
  return { cx: center[0], cy: center[1], hw: (display.width * scale[0]) / 2, hh: (display.height * scale[1]) / 2 };
}

/** Canvas backing size for a CSS box: device pixels, never larger than the sequence itself (no upscaling of the compositor) or `maxEdge`. */
export function canvasBackingSize(cssW: number, cssH: number, dpr: number, seq: { width: number; height: number }, maxEdge = 1920): { width: number; height: number } {
  const w = Math.max(1, cssW * dpr);
  const h = Math.max(1, cssH * dpr);
  const k = Math.min(1, seq.width / w, seq.height / h, maxEdge / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}
