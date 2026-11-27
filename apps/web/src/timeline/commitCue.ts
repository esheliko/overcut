/**
 * Commit feedback (M2 UX r12): a brief cue on the timeline where an edit landed (split, trim to playhead, ripple delete, close gap, paste), so the eye
 * does not have to hunt for what changed. Pure pub/sub: `Timeline.tsx` emits after an edit applied, `TimelineCanvas` paints it for `CUE_MS`.
 * Nothing allocates per frame (the canvas keeps one mutable cue record) and nothing runs under reduced motion.
 */
export type CueKind = "split" | "trim" | "ripple" | "gap" | "paste";
export interface Cue { sec: number; kind: CueKind }
export const CUE_MS = 280;

/** Which edits get a cue: the announcement key of the finished edit -> its kind. */
export const CUE_OF: Readonly<Record<string, CueKind>> = {
  "timeline.say.split": "split",
  "timeline.say.trimmed": "trim",
  "timeline.say.rippleDeleted": "ripple",
  "timeline.say.gapClosed": "gap",
  "timeline.say.pasted": "paste",
  "timeline.say.duplicated": "paste",
};

const listeners = new Set<(c: Cue) => void>();
export const onCue = (fn: (c: Cue) => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export const reducedMotion = (): boolean => {
  try { return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
};

/** Tell the timeline an edit landed at `sec`. A no-op under reduced motion or when nothing listens. */
export function emitCue(c: Cue): void {
  if (listeners.size === 0 || reducedMotion()) return;
  for (const fn of listeners) fn(c);
}
