import { THEME_EVENT } from "./theme";

/** JS accessor for design tokens, so canvas code (the timeline) draws with the same colours as the CSS. */
export const COLOR_TOKENS = [
  "bg", "surface", "surface-2", "surface-3", "line", "line-strong", "fg", "muted",
  "accent", "accent-ink", "accent-soft", "danger", "ok", "stage", "stage-fg", "clip",
] as const;
export type ColorToken = (typeof COLOR_TOKENS)[number];

/** Current value of a token (`readToken("accent")`), resolved for the active theme. Empty string if unset. */
export function readToken(name: string, root: Element = document.documentElement): string {
  return getComputedStyle(root).getPropertyValue(`--${name}`).trim();
}

/** All colour tokens at once; call again when `onThemeChange` fires. */
export function readColors(root: Element = document.documentElement): Record<ColorToken, string> {
  const cs = getComputedStyle(root);
  return Object.fromEntries(COLOR_TOKENS.map((n) => [n, cs.getPropertyValue(`--${n}`).trim()])) as Record<ColorToken, string>;
}

/** Motion duration token in ms (0 under prefers-reduced-motion), e.g. `readDurationMs("dur-base")`. */
export function readDurationMs(name: string, root: Element = document.documentElement): number {
  const v = readToken(name, root);
  return v.endsWith("ms") ? parseFloat(v) : v.endsWith("s") ? parseFloat(v) * 1000 : 0;
}

/** Subscribe to theme changes (redraw the canvas). Returns the unsubscribe function. */
export function onThemeChange(cb: () => void, root: HTMLElement = document.documentElement): () => void {
  root.addEventListener(THEME_EVENT, cb);
  return () => root.removeEventListener(THEME_EVENT, cb);
}
