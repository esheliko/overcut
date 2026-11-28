/** The timeline's zoom (pixels per second) as a tiny external store, outside the editor's React state (P-2): a wheel or pinch tick must not re-render the whole
 *  editor. The canvas and the slider subscribe; `userZoomed` remembers whether the person set the zoom by hand (auto-fit after an import leaves a hand-set zoom alone). */
import { clampPps } from "./view";

type Listener = () => void;
export type ZoomSource = "user" | "fit" | "auto";

let pps = 40;
let userZoomed = false;
const listeners = new Set<Listener>();

export const zoomStore = {
  get: (): number => pps,
  /** True once the person zoomed by hand (wheel, pinch, slider, buttons, zoom to selection) and has not pressed Fit since. */
  userZoomed: (): boolean => userZoomed,
  /** Sets the zoom. `user`: a hand-made change; `fit`: the Fit command (hands control back to auto-fit); `auto`: an automatic fit (keeps the flag). */
  set(next: number, source: ZoomSource = "user"): void {
    const v = clampPps(next);
    if (source === "user") userZoomed = true;
    else if (source === "fit") userZoomed = false;
    if (v === pps) return;
    pps = v;
    for (const l of [...listeners]) l();
  },
  subscribe(l: Listener): () => void { listeners.add(l); return () => { listeners.delete(l); }; },
  /** Tests only. */
  reset(v = 40): void { pps = v; userZoomed = false; },
};

/** A project's own zoom (pixels per second), kept per project id so a reload opens at the zoom the person chose in THAT project (r16 PHONE-17); a project they never zoomed opens fitted. */
const ZOOM_KEY = "overcut.zoom.";
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const browserStorage = (): Store | null => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };
/** The saved zoom of project `id`, or null (never zoomed by hand, storage blocked, a value that is not a usable number). */
export function loadZoom(id: string, store: Store | null = browserStorage()): number | null {
  try {
    const raw = store?.getItem(ZOOM_KEY + id);
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? clampPps(n) : null;
  } catch { return null; }
}
/** Remembers `pps` for project `id`; `null` forgets it (the person pressed Fit, so the project goes back to opening fitted). */
export function saveZoom(id: string, pps: number | null, store: Store | null = browserStorage()): void {
  try {
    if (!store) return;
    if (pps === null) store.removeItem(ZOOM_KEY + id); else store.setItem(ZOOM_KEY + id, String(Math.round(pps * 1000) / 1000));
  } catch { /* storage blocked: the project opens fitted */ }
}
