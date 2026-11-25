/** Which commands can run right now (palette: the others are listed disabled, with the reason, below the runnable ones). Pure; `Palette.tsx` supplies the state. */
import type { CommandDef } from "./registry";

export interface Availability {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Number of selected clips. */
  readonly selected: number;
  /** True when something was copied or cut. */
  readonly copied: boolean;
  /** The sequence has an in/out range. */
  readonly range: boolean;
}

/** The clipboard lives in the timeline; it says here whether it holds anything so the palette can tell. */
export const clipboardState = { copied: false, range: false };

/** Commands that need a selection to do anything. */
const NEEDS_SELECTION = new Set(["delete", "rippleDelete", "closeGap", "copy", "cut", "duplicate", "unlink", "lane", "hop", "slip", "slide", "roll", "nudge", "trimToPlayhead", "trimBy", "go"]);

/** The i18n key of why `d` cannot run now, or null when it can. */
export function whyNot(d: CommandDef, a: Availability): string | null {
  const c = d.command.c;
  if (c === "undo") return a.canUndo ? null : "palette.why.undo";
  if (c === "redo") return a.canRedo ? null : "palette.why.redo";
  if (c === "paste") return a.copied ? null : "palette.why.paste";
  if (c === "range" && (d.command as { what: string }).what !== "in" && (d.command as { what: string }).what !== "out" && !a.range) return "palette.why.range";
  if (NEEDS_SELECTION.has(c)) return a.selected > 0 ? null : "palette.why.select";
  return null;
}
