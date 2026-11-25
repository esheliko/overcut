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

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta", "OS", "CapsLock"]);
/** A modifier pressed on its own (Shift, Ctrl, Alt, Meta). It is not keyboard use of the timeline: it must not switch on the keyboard focus frame, and Shift+click still selects as before. */
export function isModifierKey(key: string): boolean { return MODIFIER_KEYS.has(key); }
