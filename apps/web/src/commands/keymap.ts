/** The user's shortcut settings, stored on this device only (no account, no sync). Fails soft: unreadable storage means the defaults. */
import { DEFAULT_SETTINGS, PRESETS, buildKeymap, commandById, type Keymap, type KeymapSettings } from "./registry";

const KEY = "overcut.keymap";
export const KEYMAP_EVENT = "overcut:keymap";

/** Accepts only what the registry knows; anything else (old ids, hand-edited junk) is dropped. */
export function parseSettings(raw: unknown): KeymapSettings {
  if (!raw || typeof raw !== "object") return DEFAULT_SETTINGS;
  const r = raw as { preset?: unknown; overrides?: unknown };
  const preset = PRESETS.some((p) => p.id === r.preset) ? (r.preset as string) : "default";
  const overrides: Record<string, string[]> = {};
  if (r.overrides && typeof r.overrides === "object") {
    for (const [id, keys] of Object.entries(r.overrides as Record<string, unknown>)) {
      if (!commandById(id) || !Array.isArray(keys) || !keys.every((k) => typeof k === "string" && k.length > 0 && k.length < 40)) continue;
      overrides[id] = keys as string[];
    }
  }
  return { preset, overrides };
}

export function loadSettings(): KeymapSettings {
  try { return parseSettings(JSON.parse(localStorage.getItem(KEY) ?? "null")); } catch { return DEFAULT_SETTINGS; }
}

let current: { settings: KeymapSettings; keymap: Keymap } | null = null;
const state = () => (current ??= { settings: loadSettings(), keymap: buildKeymap(loadSettings()) });

export function saveSettings(settings: KeymapSettings): void {
  current = { settings, keymap: buildKeymap(settings) };
  try {
    if (settings.preset === "default" && Object.keys(settings.overrides).length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(settings));
  } catch { /* not persisted */ }
  window.dispatchEvent(new CustomEvent(KEYMAP_EVENT));
}

export const currentSettings = (): KeymapSettings => state().settings;
/** The keymap in force right now (read it inside the key handler, never cache it). */
export const currentKeymap = (): Keymap => state().keymap;
