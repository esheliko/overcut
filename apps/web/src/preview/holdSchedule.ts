/** The schedule of a held frame-step button (r16 PHONE-9): pure, no React, unit-tested. */
/** Time held before the first repeat (ms). */
export const HOLD_DELAY = 400;
/** Wait (ms) between repeat `n` (0 = the first repeat) and the next: 160 ms, down to one frame of a 30 fps clip (33 ms) after about a second. */
export const repeatInterval = (n: number): number => Math.max(33, Math.round(160 * Math.pow(0.86, n)));
/** How many frames repeat `n` moves: one at first, then 2 and 4 once the hold is long (a long hold crosses a clip, it is not a frame-by-frame inspection any more). */
export const repeatFrames = (n: number): number => (n < 14 ? 1 : n < 30 ? 2 : 4);
