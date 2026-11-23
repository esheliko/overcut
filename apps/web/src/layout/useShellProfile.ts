import { useEffect, useState, type RefObject } from "react";
import { BREAKPOINTS, profileFor, type FormProfile } from "./profiles";

export interface ShellInfo { profile: FormProfile; compact: boolean }

/** Observes the editor shell (not the window), so the layout follows the space the app really has (split view, foldable, embedded). */
export function useShellProfile(ref: RefObject<HTMLElement | null>): ShellInfo {
  const [info, setInfo] = useState<ShellInfo>(() => ({ profile: profileFor(window.innerWidth, window.innerHeight), compact: window.innerWidth < BREAKPOINTS.compact }));
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (w: number, h: number) => setInfo((cur) => {
      const next = { profile: profileFor(w, h), compact: w < BREAKPOINTS.compact };
      return cur.profile === next.profile && cur.compact === next.compact ? cur : next;
    });
    apply(el.clientWidth, el.clientHeight);
    const ro = new ResizeObserver((entries) => { const r = entries[0]?.contentRect; if (r) apply(r.width, r.height); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return info;
}
