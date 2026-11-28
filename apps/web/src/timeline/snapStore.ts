/** The timeline's snapping switch (UX r14): on by default, kept on this device. Drags read `snapPx()`: the pull distance in screen pixels, 0 when snapping is off. */
import { SNAP_PX } from "./arrange";

const KEY = "overcut.snap";
const read = (): boolean => { try { return localStorage.getItem(KEY) !== "off"; } catch { return true; } };
let on = read();
const subs = new Set<() => void>();

export const snapStore = {
  get: (): boolean => on,
  subscribe: (cb: () => void): (() => void) => { subs.add(cb); return () => { subs.delete(cb); }; },
  set(next: boolean): void {
    if (next === on) return;
    on = next;
    try { localStorage.setItem(KEY, next ? "on" : "off"); } catch { /* storage unavailable: the choice lasts for this visit */ }
    subs.forEach((f) => f());
  },
};

/** The snap distance in screen pixels (0 = snapping off). */
export const snapPx = (): number => (on ? SNAP_PX : 0);
