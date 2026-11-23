/** The "smooth scrubbing" setting (on by default), kept on this device only. The storage cap is fixed at `STRIP_CAP_DEFAULT` (512 MB, least recently used segments go first). */
import { STRIP_CAP_DEFAULT } from "./store";

const KEY = "overcut.scrubPrep";
export const SCRUB_PREP_EVENT = "overcut:scrub-prep";

export function loadScrubPrep(): boolean {
  try { return localStorage.getItem(KEY) !== "off"; } catch { return true; }
}

export function saveScrubPrep(on: boolean): void {
  try { if (on) localStorage.removeItem(KEY); else localStorage.setItem(KEY, "off"); } catch { /* not persisted */ }
  try { window.dispatchEvent(new Event(SCRUB_PREP_EVENT)); } catch { /* no window */ }
}

export const scrubPrepConfig = (): { enabled: boolean; capBytes: number } => ({ enabled: loadScrubPrep(), capBytes: STRIP_CAP_DEFAULT });
