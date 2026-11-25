import { useEffect, useState } from "react";
import { KEYMAP_EVENT, currentSettings } from "./keymap";
import type { KeymapSettings } from "./registry";

/** Re-renders when the shortcut settings change. */
export function useKeymapSettings(): KeymapSettings {
  const [, tick] = useState(0);
  useEffect(() => {
    const on = () => tick((n) => n + 1);
    window.addEventListener(KEYMAP_EVENT, on);
    return () => window.removeEventListener(KEYMAP_EVENT, on);
  }, []);
  return currentSettings();
}
