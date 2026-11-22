/** Theme selection: follow the system, or a user override persisted locally. */
export const THEMES = ["dark", "light", "high-contrast"] as const;
export type Theme = (typeof THEMES)[number];
export type ThemePref = "system" | Theme;
export const THEME_PREFS: readonly ThemePref[] = ["system", ...THEMES];
export const THEME_EVENT = "overcut:theme";
const STORE_KEY = "overcut.theme";

export type SystemQuery = (q: string) => boolean;
const browserQuery: SystemQuery = (q) => typeof matchMedia === "function" && matchMedia(q).matches;

/** The theme the system asks for: more contrast beats colour scheme. Default (no preference) is dark. */
export function resolveTheme(pref: ThemePref, query: SystemQuery = browserQuery): Theme {
  if (pref !== "system") return pref;
  if (query("(prefers-contrast: more)")) return "high-contrast";
  return query("(prefers-color-scheme: light)") ? "light" : "dark";
}

export function parsePref(v: unknown): ThemePref {
  return THEME_PREFS.includes(v as ThemePref) ? (v as ThemePref) : "system";
}

export function loadPref(): ThemePref {
  try { return parsePref(localStorage.getItem(STORE_KEY)); } catch { return "system"; }
}
export function savePref(pref: ThemePref): void {
  try {
    if (pref === "system") localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, pref);
  } catch { /* not persisted */ }
}

/** Set `<html data-theme>` and tell canvas code to re-read tokens. */
export function applyTheme(pref: ThemePref, root: HTMLElement = document.documentElement): Theme {
  const theme = resolveTheme(pref);
  root.dataset.theme = theme;
  root.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { theme } }));
  return theme;
}

/** Re-resolve when the system preference changes while the user is following it. */
export function watchSystem(getPref: () => ThemePref, onChange: (t: Theme) => void): () => void {
  if (typeof matchMedia !== "function") return () => undefined;
  const mqs = ["(prefers-contrast: more)", "(prefers-color-scheme: light)"].map((q) => matchMedia(q));
  const on = () => { if (getPref() === "system") onChange(applyTheme("system")); };
  mqs.forEach((m) => m.addEventListener("change", on));
  return () => mqs.forEach((m) => m.removeEventListener("change", on));
}

export function nextPref(p: ThemePref): ThemePref {
  return THEME_PREFS[(THEME_PREFS.indexOf(p) + 1) % THEME_PREFS.length]!;
}
