import { useCallback, useState } from "react";

/** A side panel's collapsed state, remembered on this device only (storage that fails just means it starts expanded). */
export function useCollapsed(name: string): [boolean, (next: boolean) => void] {
  const key = `overcut.layout.collapsed.${name}`;
  const [collapsed, set] = useState<boolean>(() => {
    try { return localStorage.getItem(key) === "1"; } catch { return false; }
  });
  const setCollapsed = useCallback((next: boolean) => {
    set(next);
    try { if (next) localStorage.setItem(key, "1"); else localStorage.removeItem(key); } catch { /* not remembered */ }
  }, [key]);
  return [collapsed, setCollapsed];
}
