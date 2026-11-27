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
