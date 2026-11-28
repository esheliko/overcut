import { useEffect, useRef } from "react";

/**
 * The Back button / swipe-back gesture closes the top-most sheet or dialog before it leaves the editor (a phone has no other "close" than Back).
 * Each open layer pushes one history entry (same URL); Back pops it and the layer closes. When a layer closes by any other means (its own X, Escape,
 * the backdrop) its entry is taken off again, so Back does not step through ghosts. No router is involved: the app has one URL.
 */
type Layer = { close(): void };
const stack: Layer[] = [];
let ignore = 0; // popstate events caused by our own `history.back()`
let wired = false;
const MARK = "overcutLayer";

function onPop(e: PopStateEvent): void {
  if (ignore > 0) { ignore--; if (ignore === 0) flush(); return; }
  // Every entry we pushed carries its depth (1 = first layer); the entry underneath all layers has none (0). Back lands on a lower depth: close down to it.
  // Forward lands on a higher one: nothing to close.
  const depth = Number((e.state as Record<string, unknown> | null)?.[MARK] ?? 0);
  while (stack.length > depth) stack.pop()?.close();
}

/** Layers opened while one of our own `history.back()` calls is still travelling (a menu closing as its dialog opens) wait for it: a push in between would land on the wrong entry. */
let pending: Layer[] = [];
function activate(layer: Layer): void {
  stack.push(layer);
  try { history.pushState({ ...(history.state as object | null), [MARK]: stack.length }, ""); } catch { /* sandboxed frame: Back just leaves, as before */ }
}
function flush(): void {
  const q = pending;
  pending = [];
  for (const l of q) activate(l);
}
function release(layer: Layer): void {
  const at = stack.indexOf(layer);
  if (at < 0) return; // Back already took it
  stack.splice(at, 1);
  if (at === stack.length) { ignore++; try { history.back(); } catch { ignore--; } } // it was the top: drop its entry too
}

/** Opens a layer; the returned function ends it when it closed by other means than Back. Exported for tests. */
export function pushLayer(close: () => void): () => void {
  if (typeof history === "undefined") return () => undefined;
  if (!wired) { wired = true; addEventListener("popstate", onPop); }
  const layer: Layer = { close };
  if (ignore > 0) {
    pending.push(layer);
    return () => { const i = pending.indexOf(layer); if (i >= 0) pending.splice(i, 1); else release(layer); };
  }
  activate(layer);
  return () => release(layer);
}

/** While `open`, Back closes this layer (`onClose`). */
export function useBackClose(open: boolean, onClose: () => void): void {
  const cb = useRef(onClose);
  cb.current = onClose;
  useEffect(() => {
    if (!open) return;
    return pushLayer(() => cb.current());
  }, [open]);
}
