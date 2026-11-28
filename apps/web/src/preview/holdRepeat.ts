/** Press-and-hold repeat for the Previous / Next frame buttons (r16 PHONE-9): one step at once, after `HOLD_DELAY` the step repeats, then accelerates, the way the key does on a keyboard.
 *  The schedule is pure (unit-tested); the hook only wires pointers to it. Touch and mouse behave the same. */
import { useCallback, useEffect, useRef, type MouseEvent, type PointerEvent } from "react";

import { HOLD_DELAY, repeatFrames, repeatInterval } from "./holdSchedule";

/** Handlers for a button that fires `fire(frames)` on press and keeps firing while it is held. Spread them on the button. A keyboard activation (click with detail 0) fires once. */
export function useHoldRepeat(fire: (frames: number) => void) {
  const live = useRef(fire);
  live.current = fire;
  const timer = useRef(0);
  const stop = useCallback(() => { window.clearTimeout(timer.current); timer.current = 0; }, []);
  useEffect(() => stop, [stop]);
  const onPointerDown = useCallback((e: PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    stop();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    live.current(1);
    let n = 0;
    const tick = () => { live.current(repeatFrames(n)); const wait = repeatInterval(n); n++; timer.current = window.setTimeout(tick, wait); };
    timer.current = window.setTimeout(tick, HOLD_DELAY);
  }, [stop]);
  const onClick = useCallback((e: MouseEvent<HTMLButtonElement>) => { if (e.detail === 0) live.current(1); }, []);
  const onContextMenu = useCallback((e: MouseEvent) => e.preventDefault(), []); // a long touch press must not open the browser's menu
  return { onPointerDown, onPointerUp: stop, onPointerCancel: stop, onLostPointerCapture: stop, onClick, onContextMenu };
}
