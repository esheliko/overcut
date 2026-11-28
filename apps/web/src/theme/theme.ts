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

/** First run (nothing stored) opens dark, like a pro editor; "follow the system" is an explicit choice that is stored too (r14). */
export function loadPref(): ThemePref {
  try {
    const v = localStorage.getItem(STORE_KEY);
    return v === null ? "dark" : parsePref(v);
  } catch { return "dark"; }
}
export function savePref(pref: ThemePref): void {
  try { localStorage.setItem(STORE_KEY, pref); } catch { /* not persisted */ }
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

// ---- accent colour (UX-05): a second, independent choice on top of the theme ----
/** `teal` is the base token set; the rest override --accent* and --clip in tokens.css (`:root[data-theme][data-accent]`). */
export const ACCENTS = ["teal", "blue", "violet", "pink", "orange", "green", "yellow"] as const;
export type Accent = (typeof ACCENTS)[number];
const ACCENT_KEY = "overcut.accent";
/** The swatch shown in the picker: the colour the accent has in the dark theme (decorative; the name is the accessible label). */
export const ACCENT_SWATCH: Record<Accent, string> = { teal: "#2de2d6", blue: "#6aa8ff", violet: "#a58bff", pink: "#ff7ab6", orange: "#ff9f4a", green: "#5fd97a", yellow: "#f2cf4a" };

export function parseAccent(v: unknown): Accent {
  return ACCENTS.includes(v as Accent) ? (v as Accent) : "teal";
}
export function loadAccent(): Accent {
  try { return parseAccent(localStorage.getItem(ACCENT_KEY)); } catch { return "teal"; }
}
export function saveAccent(a: Accent): void {
  try {
    if (a === "teal") localStorage.removeItem(ACCENT_KEY);
    else localStorage.setItem(ACCENT_KEY, a);
  } catch { /* not persisted */ }
}
/** Set `<html data-accent>` and tell canvas code to re-read tokens (the theme event carries the unchanged theme). */
export function applyAccent(a: Accent, root: HTMLElement = document.documentElement): void {
  root.dataset.accent = a;
  root.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { theme: root.dataset.theme } }));
}

/** Canvas text uses `Inter`: ask for the faces the canvas draws with, then tell canvas code to repaint (same event as a theme change). Never throws; no fonts API = nothing to do. */
export function redrawWhenFontsLoad(root: HTMLElement = document.documentElement): void {
  const fonts = typeof document !== "undefined" ? document.fonts : undefined;
  if (!fonts?.load) return;
  Promise.all(["500 12px Inter", "600 12px Inter", "700 12px Inter"].map((f) => fonts.load(f)))
    .then(() => root.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { theme: root.dataset.theme } })))
    .catch(() => undefined);
}
