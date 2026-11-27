/**
 * Pacing for background media work (thumbnails, waveform extraction) that still runs on the UI thread (P-7): between steps it gives the
 * event loop back, and it holds off entirely while the user plays or drags (a pointer is down), so an import never causes a hitch in what the
 * user is doing. Work resumes by itself a moment after playback stops or the pointer is released.
 */
let playing = false;
let pointers = 0;
let installed = false;
const waiters = new Set<() => void>();

const wake = () => { if (!busy()) for (const w of [...waiters]) w(); };
const busy = () => playing || pointers > 0;

/** The preview reports play/pause here. */
export function setPlaybackBusy(p: boolean): void {
  playing = p;
  wake();
}

function install(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const down = () => { pointers++; };
  const up = () => { pointers = Math.max(0, pointers - 1); wake(); };
  window.addEventListener("pointerdown", down, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", up, true);
  window.addEventListener("blur", () => { pointers = 0; wake(); });
}

/** Hand the event loop back once (the scheduler's `yield` where it exists: it keeps the task's priority; else a zero timeout). */
export function yieldToEventLoop(): Promise<void> {
  const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  return s?.yield ? s.yield() : new Promise<void>((r) => setTimeout(r, 0));
}

/** True while background work should wait (playing, or a pointer is down). */
export const backgroundBusy = (): boolean => (install(), busy());

/**
 * Call between steps of background work: yields to the event loop, and while the user plays or drags waits until that ends (re-checked at
 * least every 500 ms). Costs one zero-delay timeout in tests and on the server, where there is no pointer or playback.
 */
export async function pace(): Promise<void> {
  install();
  await yieldToEventLoop();
  while (busy()) {
    await new Promise<void>((resolve) => {
      const done = () => { waiters.delete(done); clearTimeout(t); resolve(); };
      const t = setTimeout(done, 500); // a safety net: never wait on an event that was missed
      waiters.add(done);
    });
  }
}
