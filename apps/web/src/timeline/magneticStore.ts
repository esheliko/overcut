/** The magnetic main track switch (UX r15): on by default, kept on this device. While on, trimming or deleting a clip on the lowest video track closes the gap
 *  it would leave (ripple), like CapCut's main track. Other tracks stay free. */
const KEY = "overcut.magnetic";
const read = (): boolean => { try { return localStorage.getItem(KEY) !== "off"; } catch { return true; } };
let on = read();
const subs = new Set<() => void>();

export const magneticStore = {
  get: (): boolean => on,
  subscribe: (cb: () => void): (() => void) => { subs.add(cb); return () => { subs.delete(cb); }; },
  set(next: boolean): void {
    if (next === on) return;
    on = next;
    try { localStorage.setItem(KEY, next ? "on" : "off"); } catch { /* storage unavailable: the choice lasts for this visit */ }
    subs.forEach((f) => f());
  },
};
