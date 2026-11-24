/** Pure helpers for the projects list (`tests/unit/projects.test.ts`). */

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [["day", 86_400_000], ["hour", 3_600_000], ["minute", 60_000]];

/** "5 minutes ago", "yesterday", or the date once it is older than a week. `now - at` below a minute reads "just now" via `justNow`. */
export function whenLabel(at: number, now: number, locale: string | undefined, justNow: string): string {
  const diff = now - at;
  if (diff < 60_000) return justNow;
  if (diff < 7 * 86_400_000) {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    for (const [unit, ms] of UNITS) if (diff >= ms) return rtf.format(-Math.floor(diff / ms), unit);
  }
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(at);
}

/** The outline of the project's canvas shape inside a `box` x `box` square: the real aspect ratio, nothing else (no invented thumbnail). */
export function shapeBox(width: number | undefined, height: number | undefined, box = 44): { w: number; h: number } {
  if (!width || !height || width <= 0 || height <= 0) return { w: box, h: Math.round(box * 9 / 16) };
  const k = box / Math.max(width, height);
  return { w: Math.max(8, Math.round(width * k)), h: Math.max(8, Math.round(height * k)) };
}

/** What to show first: the list when there are several projects, the editor when there is exactly one, a new project when there are none. */
export function startScreen(count: number): "home" | "editor" | "new" {
  return count === 0 ? "new" : count === 1 ? "editor" : "home";
}
