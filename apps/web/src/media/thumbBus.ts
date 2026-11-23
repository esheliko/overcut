/** Announces every filmstrip thumbnail the timeline makes, so the preview can use the nearest one as a scrub stand-in (docs/features/preview.md). Fail-soft: no listener, no cost. */
export type ThumbListener = (media: string, seconds: number, bitmap: ImageBitmap) => void;

const listeners = new Set<ThumbListener>();

export function onThumb(l: ThumbListener): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}

export function emitThumb(media: string, seconds: number, bitmap: ImageBitmap): void {
  for (const l of listeners) {
    try { l(media, seconds, bitmap); } catch { /* a stand-in is optional */ }
  }
}
