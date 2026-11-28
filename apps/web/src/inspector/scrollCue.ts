import { useCallback, useEffect, useRef } from "react";

/**
 * A bottom fade while a panel body is clipped (UX r16, DESK-17): sets `data-more` on the element whenever there is more content below the fold; CSS fades the last
 * rows out. Re-checked on scroll, on resize and when the content changes (a section opens), at most once a frame.
 */
export function useScrollCue<T extends HTMLElement>(): (el: T | null) => void {
  const off = useRef<(() => void) | null>(null);
  useEffect(() => () => off.current?.(), []);
  return useCallback((el: T | null) => {
    off.current?.();
    off.current = null;
    if (!el) return;
    let raf = 0;
    const check = () => {
      raf = 0;
      const more = el.scrollHeight - el.clientHeight - el.scrollTop > 4;
      if (more) el.setAttribute("data-more", ""); else el.removeAttribute("data-more");
    };
    const soon = () => { if (!raf) raf = requestAnimationFrame(check); };
    el.addEventListener("scroll", soon, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(soon);
    ro?.observe(el);
    const mo = new MutationObserver(soon);
    mo.observe(el, { childList: true, subtree: true });
    soon();
    off.current = () => { el.removeEventListener("scroll", soon); ro?.disconnect(); mo.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, []);
}
