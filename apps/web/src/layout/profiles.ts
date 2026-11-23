/** The five form-factor profiles of the editor shell (docs/features/editor-layouts.md). styles.css uses the same numbers in `@container editor (...)`; tests/unit/layout-profiles.test.ts keeps them in sync. */
export type FormProfile = "phone-portrait" | "phone-landscape" | "tablet" | "desktop" | "ultrawide";

export const BREAKPOINTS = {
  /** Width from which the tool panel is docked beside the preview (tablet and up). */
  tablet: 720,
  /** Width from which the details panel gets its own column. */
  desktop: 1100,
  /** Ultrawide: at least this wide AND at least 2:1. */
  ultrawide: 1900,
  /** Phone landscape: a short screen on its side. */
  landscapeMaxHeight: 500,
  landscapeMaxWidth: 1000,
  /** Small phone: theme toggle and engine status move into the menu. */
  compact: 480,
} as const;

export function profileFor(width: number, height: number): FormProfile {
  const b = BREAKPOINTS;
  if (width > height && height <= b.landscapeMaxHeight && width <= b.landscapeMaxWidth) return "phone-landscape";
  if (width < b.tablet) return "phone-portrait";
  if (width >= b.ultrawide && width >= height * 2) return "ultrawide";
  if (width >= b.desktop) return "desktop";
  return "tablet";
}
