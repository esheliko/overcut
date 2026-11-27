/**
 * Confirmation haptics (M2 UX r12): one 10 ms tick, only for the moments a touch user cannot see through their finger: a snap engaging under a drag,
 * a long-press pick-up, a split. Android browsers only (`navigator.vibrate` does not exist on iOS); touch devices only; never per tap or per frame.
 * `localStorage["overcut.haptics"] = "off"` silences it (there is no settings screen for it yet).
 */
const KEY = "overcut.haptics";
export function haptic(): void {
  try {
    if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
    if (typeof matchMedia === "function" && !matchMedia("(pointer: coarse)").matches) return;
    if (localStorage.getItem(KEY) === "off") return;
    navigator.vibrate(10);
  } catch { /* no haptics */ }
}
