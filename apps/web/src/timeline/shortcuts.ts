/** Keyboard shortcuts for timeline editing, as pure data: key event in, command out. */
export type Command =
  | { c: "undo" } | { c: "redo" } | { c: "split" } | { c: "delete" } | { c: "selectAll" } | { c: "clear" } | { c: "pick" } | { c: "copy" } | { c: "cut" } | { c: "paste" } | { c: "duplicate" } | { c: "unlink" }
  | { c: "go"; dir: "left" | "right" | "up" | "down" }
  /** Move the selection by whole frames. */
  | { c: "nudge"; frames: number }
  /** Trim the selected clip's edge to the playhead. */
  | { c: "trimToPlayhead"; edge: "start" | "end" }
  /** Trim the selected clip's edge by whole frames. */
  | { c: "trimBy"; edge: "start" | "end"; frames: number }
  /** Step the playhead (Alt + arrows, used while a selection owns the plain arrows). */
  | { c: "playhead"; frames: number };

export interface KeyLike { key: string; code: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }

/** Shortcuts that work anywhere in the editor (not typing in a field). */
export function globalCommand(e: KeyLike): Command | null {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && !e.altKey) {
    if (k === "z") return e.shiftKey ? { c: "redo" } : { c: "undo" };
    if (k === "y") return { c: "redo" };
    if (e.shiftKey) return null;
    if (k === "c") return { c: "copy" };
    if (k === "x") return { c: "cut" };
    if (k === "v") return { c: "paste" };
    if (k === "d") return { c: "duplicate" };
    return null;
  }
  if (mod || e.altKey) return null;
  if (k === "s" && !e.shiftKey) return { c: "split" };
  if (e.key === "Delete" || e.key === "Backspace") return { c: "delete" };
  return null;
}

/** Shortcuts that apply while the timeline canvas has focus. `hasSelection` decides who owns the plain arrow keys. */
export function canvasCommand(e: KeyLike, hasSelection: boolean): Command | null {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "a") return { c: "selectAll" };
  if (mod) return null;
  if (e.key === "Escape") return { c: "clear" };
  if (e.key === "Enter") return { c: "pick" };
  const dir = ({ ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" } as const)[e.key as "ArrowLeft"];
  if (dir && e.altKey && (dir === "left" || dir === "right")) return { c: "playhead", frames: (dir === "left" ? -1 : 1) * (e.shiftKey ? 30 : 1) };
  if (dir && hasSelection && !e.altKey) return { c: "go", dir };
  const step = (e.code === "Comma" ? -1 : e.code === "Period" ? 1 : 0);
  if (step) {
    if (e.altKey) return { c: "trimBy", edge: e.shiftKey ? "start" : "end", frames: step };
    return { c: "nudge", frames: step * (e.shiftKey ? 10 : 1) };
  }
  if (e.code === "BracketLeft") return { c: "trimToPlayhead", edge: "start" };
  if (e.code === "BracketRight") return { c: "trimToPlayhead", edge: "end" };
  return null;
}
