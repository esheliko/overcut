/** Display size and canvas size maths. The layer placement and the display-rotation texture mapping live in the Rust compositor (`app_render`). */
export type Rotation = 0 | 90 | 180 | 270;

export const normalizeRotation = (deg: number): Rotation => ((((Math.round(deg / 90) * 90) % 360) + 360) % 360) as Rotation;

/** Size as displayed (width and height swap for 90 and 270). */
export function displaySize(width: number, height: number, rotation: number): { width: number; height: number } {
  const r = normalizeRotation(rotation);
  return r === 90 || r === 270 ? { width: height, height: width } : { width, height };
}

/** Canvas backing size for a CSS box: device pixels, never larger than the sequence itself (no upscaling of the compositor) or `maxEdge`. */
export function canvasBackingSize(cssW: number, cssH: number, dpr: number, seq: { width: number; height: number }, maxEdge = 1920): { width: number; height: number } {
  const w = Math.max(1, cssW * dpr);
  const h = Math.max(1, cssH * dpr);
  const k = Math.min(1, seq.width / w, seq.height / h, maxEdge / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}
