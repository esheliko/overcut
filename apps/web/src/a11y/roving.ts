import { useCallback, useRef, useState, type KeyboardEvent } from "react";

export type Orientation = "horizontal" | "vertical" | "both";

/**
 * Which item a key moves to in a roving-tabindex group, or null if the key is not handled.
 * Horizontal arrows swap meaning in RTL; Home/End jump to the ends; `loop` wraps around.
 */
export function nextRovingIndex(current: number, key: string, count: number, opts: { orientation?: Orientation; rtl?: boolean; loop?: boolean } = {}): number | null {
  const { orientation = "horizontal", rtl = false, loop = true } = opts;
  if (count <= 0) return null;
  const h = orientation !== "vertical";
  const v = orientation !== "horizontal";
  let delta = 0;
  if (h && key === "ArrowRight") delta = rtl ? -1 : 1;
  else if (h && key === "ArrowLeft") delta = rtl ? 1 : -1;
  else if (v && key === "ArrowDown") delta = 1;
  else if (v && key === "ArrowUp") delta = -1;
  else if (key === "Home") return 0;
  else if (key === "End") return count - 1;
  else return null;
  const n = current + delta;
  if (n < 0) return loop ? count - 1 : 0;
  if (n >= count) return loop ? 0 : count - 1;
  return n;
}

/** Roving tabindex: one item is in the tab order (tabIndex 0), arrow keys move focus between items. */
export function useRovingTabindex(count: number, opts: { orientation?: Orientation; rtl?: boolean; loop?: boolean; initial?: number; onMove?: (i: number) => void } = {}) {
  const [active, setActive] = useState(opts.initial ?? 0);
  const refs = useRef<(HTMLElement | null)[]>([]);
  const { onMove } = opts;
  const move = useCallback((i: number) => {
    setActive(i);
    refs.current[i]?.focus();
    onMove?.(i);
  }, [onMove]);
  const itemProps = (i: number) => ({
    ref: (el: HTMLElement | null) => { refs.current[i] = el; },
    tabIndex: i === Math.min(active, count - 1) ? 0 : -1,
    onFocus: () => setActive(i),
    onKeyDown: (e: KeyboardEvent) => {
      const n = nextRovingIndex(i, e.key, count, opts);
      if (n === null) return;
      e.preventDefault();
      move(n);
    },
  });
  return { active, itemProps };
}
