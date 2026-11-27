import { useEffect } from "react";

/** How much of the layout viewport the on-screen keyboard covers (px), from the visual viewport; 0 when there is no keyboard (small toolbars changing height do not count). */
export function keyboardInset(layoutHeight: number, vv: { height: number; offsetTop: number }): number {
  const covered = layoutHeight - vv.height - vv.offsetTop;
  return covered > 120 ? Math.round(covered) : 0;
}

/**
 * While `active`, publishes `--kb` (the keyboard's height) and `--vvh` (the visible height) on the root so a fixed bottom sheet can sit above the keyboard
 * instead of under it (iOS and Android Chrome keep the layout viewport and only shrink the visual one). Nothing happens without `visualViewport`.
 */
export function useKeyboardInset(active: boolean): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!active || !vv) return;
    const root = document.documentElement.style;
    const apply = () => {
      root.setProperty("--kb", `${keyboardInset(window.innerHeight, vv)}px`);
      root.setProperty("--vvh", `${Math.round(vv.height)}px`);
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => { vv.removeEventListener("resize", apply); vv.removeEventListener("scroll", apply); root.removeProperty("--kb"); root.removeProperty("--vvh"); };
  }, [active]);
}
