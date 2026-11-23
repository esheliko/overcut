/** File names of saved projects (pure: `tests/unit/canvas.test.ts`). */
export const PROJECT_EXT = ".overcut";

/** A file name that is safe on every system: no path separators or control characters, `.overcut` appended, never empty. */
export function projectFileName(name: string): string {
  const base = Array.from(name, (ch) => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? "" : ch)).join("").trim().replace(/\.overcut$/i, "").slice(0, 80).trim();
  return `${base || "Untitled project"}${PROJECT_EXT}`;
}

/** The name shown for an opened file ("My film.overcut" -> "My film"). */
export const nameOfFile = (file: string): string => file.replace(/\.overcut$/i, "").trim();
