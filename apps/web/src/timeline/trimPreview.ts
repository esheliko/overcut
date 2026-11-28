/** The frame the preview shows while an edge is dragged (r16 DESK-15, PHONE-8): the picture under the edge being trimmed, so a person can find the cut point by eye.
 *  A tiny external store outside React state: the canvas writes it on every pointer move, the preview panel reads it at most once per animation frame. `null` = no trim in progress
 *  (the preview returns to the playhead). */
type Listener = () => void;
let frame: number | null = null;
const listeners = new Set<Listener>();

export const trimPreview = {
  get: (): number | null => frame,
  /** The frame to show, or null when the trim ended. Equal values are not announced. */
  set(next: number | null): void {
    if (next === frame) return;
    frame = next;
    for (const l of [...listeners]) l();
  },
  subscribe(l: Listener): () => void { listeners.add(l); return () => { listeners.delete(l); }; },
};

/** The frame under a trimmed edge. `edge` start: the first frame the clip will show; end: the last frame it will show (one frame before the new out point). The result stays inside the
 *  clip as it is now (`startSec`..`endSec`), because the picture beyond it is not the clip's until the trim is committed. */
export function trimEdgeFrame(edge: "start" | "end", valueSec: number, startSec: number, endSec: number, fps: number): number {
  const first = Math.round(startSec * fps), last = Math.max(first, Math.round(endSec * fps) - 1);
  const f = edge === "start" ? Math.round(valueSec * fps) : Math.round(valueSec * fps) - 1;
  return Math.min(last, Math.max(first, f));
}
