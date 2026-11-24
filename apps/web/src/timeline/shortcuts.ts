/** Keyboard shortcuts for timeline editing: key event in, command out. The bindings live in the registry (`commands/registry.ts`); this adapts it to the timeline. */
import { currentKeymap } from "../commands/keymap";
import { resolveKey, type Command, type Keymap, type KeyLike } from "../commands/registry";

export type { Command, KeyLike };

/** Shortcuts that work anywhere in the editor (not typing in a field). */
export function globalCommand(e: KeyLike, keymap: Keymap = currentKeymap()): Command | null {
  return resolveKey(e, "global", keymap)?.command ?? null;
}

/** Shortcuts that apply while the timeline canvas has focus. `hasSelection` decides who owns the plain arrow keys. */
export function canvasCommand(e: KeyLike, hasSelection: boolean, keymap: Keymap = currentKeymap()): Command | null {
  return resolveKey(e, "canvas", keymap, hasSelection)?.command ?? null;
}
