/**
 * The command and shortcut registry (UX-03). One table of every keyboard command: id, label key, context, default keys.
 * Pure data and pure functions: key event + keymap in, command out. Presets ("like X") only re-bind a few commands on top of the defaults;
 * the user's own remaps sit on top of the preset and are stored locally (`keymap.ts`).
 */

/** What a command does. Timeline commands carry the payload the timeline already understood before the registry existed. */
export type Command =
  | { c: "palette" }
  | { c: "undo" } | { c: "redo" } | { c: "split" } | { c: "delete" } | { c: "selectAll" } | { c: "clear" } | { c: "pick" } | { c: "copy" } | { c: "cut" } | { c: "paste" } | { c: "duplicate" } | { c: "unlink" }
  /** Ripple delete (pull the rest of the track in) and close the empty gap before the selection. */
  | { c: "rippleDelete" } | { c: "closeGap" }
  /** Pick the edit tool (the toolbar's), or edit the selection by whole frames: slip the source window, slide between neighbours, roll its end cut. */
  | { c: "tool"; tool: "select" | "ripple" | "roll" | "slip" | "slide" }
  /** Move the selection one lane up or down (same kind of track). */
  | { c: "lane"; dir: "up" | "down" }
  /** Keyboard reorder: hop over the neighbouring clip; and the track switches of the selected clip's track. */
  | { c: "hop"; dir: 1 | -1 } | { c: "trackToggle"; part: "mute" | "solo" | "lock" | "hide" }
  | { c: "slip"; frames: number } | { c: "slide"; frames: number } | { c: "roll"; frames: number }
  | { c: "go"; dir: "left" | "right" | "up" | "down" }
  /** Move the selection by whole frames. */
  | { c: "nudge"; frames: number }
  /** Trim the selected clip's edge to the playhead. */
  | { c: "trimToPlayhead"; edge: "start" | "end" }
  /** Trim the selected clip's edge by whole frames. */
  | { c: "trimBy"; edge: "start" | "end"; frames: number }
  /** Step the playhead (Alt + arrows, used while a selection owns the plain arrows). */
  | { c: "playhead"; frames: number }
  /** Playhead steps in the timeline: `frames` whole frames, or `seconds` seconds, or jump to the start or end. */
  | { c: "step"; frames?: number; seconds?: number; to?: "start" | "end" }
  /** Markers (M2-046): add one at the playhead, open the menu of the one at the playhead. */
  | { c: "marker" } | { c: "markerEdit" }
  /** The in/out range (M2-046): set in / out at the playhead, clear it, loop it, play it. */
  | { c: "range"; what: "in" | "out" | "clear" | "loop" | "play" }
  | { c: "zoom"; how: "in" | "out" | "fit" | "selection" }
  /** Put a media item on the timeline at the playhead (the selected clip's media, else the newest in the bin): on its track, or as an overlay on a new video track. */
  | { c: "addMedia"; overlay: boolean }
  | { c: "scroll"; how: "pageLeft" | "pageRight" | "up" | "down" }
  /** The preview (M2 UX): full-screen picture, loop playback on or off. Handled by the preview panel (it listens for COMMAND_EVENT and reads the keys itself). */
  | { c: "preview"; what: "fullscreen" | "loop" }
  /** Transport keys, handled by the preview panel. */
  | { c: "play" } | { c: "shuttle"; key: "J" | "K" | "L" } | { c: "seek"; frames: number } | { c: "seek"; to: "start" | "end" };

/** Where a command is live. `global` works anywhere except typing in a field; `canvas` only with the timeline canvas focused; `transport` is the player's window-level keys. */
export type Context = "global" | "canvas" | "transport";
/** `selection`: only while clips are selected (selection owns the arrows); `noSelection`: only without. */
export type When = "selection" | "noSelection";

export interface CommandDef {
  id: string;
  /** i18n key of the visible and accessible name. */
  label: string;
  context: Context;
  /** Default chords, e.g. `Mod+Shift+Z`, `Alt+ArrowLeft`, `Comma`. */
  keys: readonly string[];
  command: Command;
  when?: When;
  /** The preview panel still reads its keys itself (lane B owns that file), so these are listed but cannot be changed yet. */
  fixed?: boolean;
}

const D = (id: string, context: Context, keys: readonly string[], command: Command, extra: { when?: When; fixed?: boolean } = {}): CommandDef =>
  ({ id, label: `cmd.${id}`, context, keys, command, ...extra });

export const COMMANDS: readonly CommandDef[] = [
  /** Opens the command palette (Ctrl/Cmd+K; also a button in the top bar and a menu row). */
  D("app.palette", "global", ["Mod+K"], { c: "palette" }),
  D("edit.undo", "global", ["Mod+Z"], { c: "undo" }),
  D("edit.redo", "global", ["Mod+Shift+Z", "Mod+Y"], { c: "redo" }),
  D("edit.copy", "global", ["Mod+C"], { c: "copy" }),
  D("edit.cut", "global", ["Mod+X"], { c: "cut" }),
  D("edit.paste", "global", ["Mod+V"], { c: "paste" }),
  D("edit.duplicate", "global", ["Mod+D"], { c: "duplicate" }),
  /** No default key on m2 (a button in the timeline toolbar); registered so the palette and the remap list can reach it. */
  D("edit.unlink", "global", [], { c: "unlink" }),
  D("edit.split", "global", ["S"], { c: "split" }),
  D("edit.delete", "global", ["Delete", "Backspace"], { c: "delete" }),

  D("edit.rippleDelete", "global", ["Shift+Delete", "Shift+Backspace"], { c: "rippleDelete" }),
  D("edit.closeGap", "global", ["Mod+Delete", "Mod+Backspace"], { c: "closeGap" }),

  D("tool.select", "global", ["V"], { c: "tool", tool: "select" }),
  D("tool.ripple", "global", ["B"], { c: "tool", tool: "ripple" }),
  D("tool.roll", "global", ["N"], { c: "tool", tool: "roll" }),
  D("tool.slip", "global", ["Y"], { c: "tool", tool: "slip" }),
  D("tool.slide", "global", ["U"], { c: "tool", tool: "slide" }),

  D("track.mute", "global", ["Shift+M"], { c: "trackToggle", part: "mute" }),
  D("track.solo", "global", [], { c: "trackToggle", part: "solo" }),
  D("track.lock", "global", [], { c: "trackToggle", part: "lock" }),
  D("track.hide", "global", ["Shift+H"], { c: "trackToggle", part: "hide" }),

  D("select.all", "canvas", ["Mod+A"], { c: "selectAll" }),
  D("select.clear", "canvas", ["Escape"], { c: "clear" }),
  D("select.pick", "canvas", ["Enter"], { c: "pick" }),
  D("select.left", "canvas", ["ArrowLeft", "Shift+ArrowLeft"], { c: "go", dir: "left" }, { when: "selection" }),
  D("select.right", "canvas", ["ArrowRight", "Shift+ArrowRight"], { c: "go", dir: "right" }, { when: "selection" }),
  D("select.up", "canvas", ["ArrowUp", "Shift+ArrowUp"], { c: "go", dir: "up" }, { when: "selection" }),
  D("select.down", "canvas", ["ArrowDown", "Shift+ArrowDown"], { c: "go", dir: "down" }, { when: "selection" }),
  D("clip.nudgeBack", "canvas", ["Comma"], { c: "nudge", frames: -1 }),
  D("clip.nudgeForward", "canvas", ["Period"], { c: "nudge", frames: 1 }),
  D("clip.nudgeBack10", "canvas", ["Shift+Comma"], { c: "nudge", frames: -10 }),
  D("clip.nudgeForward10", "canvas", ["Shift+Period"], { c: "nudge", frames: 10 }),
  D("clip.trimStartToPlayhead", "canvas", ["BracketLeft"], { c: "trimToPlayhead", edge: "start" }),
  D("clip.trimEndToPlayhead", "canvas", ["BracketRight"], { c: "trimToPlayhead", edge: "end" }),
  D("clip.trimEndBack", "canvas", ["Alt+Comma"], { c: "trimBy", edge: "end", frames: -1 }),
  D("clip.trimEndForward", "canvas", ["Alt+Period"], { c: "trimBy", edge: "end", frames: 1 }),
  D("clip.trimStartBack", "canvas", ["Alt+Shift+Comma"], { c: "trimBy", edge: "start", frames: -1 }),
  D("clip.trimStartForward", "canvas", ["Alt+Shift+Period"], { c: "trimBy", edge: "start", frames: 1 }),

  D("clip.laneUp", "canvas", ["Alt+ArrowUp"], { c: "lane", dir: "up" }),
  D("clip.laneDown", "canvas", ["Alt+ArrowDown"], { c: "lane", dir: "down" }),
  D("clip.hopBack", "canvas", ["Mod+Alt+ArrowLeft"], { c: "hop", dir: -1 }),
  D("clip.hopForward", "canvas", ["Mod+Alt+ArrowRight"], { c: "hop", dir: 1 }),
  D("clip.slipBack", "canvas", ["Mod+Comma"], { c: "slip", frames: -1 }),
  D("clip.slipForward", "canvas", ["Mod+Period"], { c: "slip", frames: 1 }),
  D("clip.slideBack", "canvas", ["Mod+Shift+Comma"], { c: "slide", frames: -1 }),
  D("clip.slideForward", "canvas", ["Mod+Shift+Period"], { c: "slide", frames: 1 }),
  D("clip.rollBack", "canvas", ["Mod+Alt+Comma"], { c: "roll", frames: -1 }),
  D("clip.rollForward", "canvas", ["Mod+Alt+Period"], { c: "roll", frames: 1 }),

  D("media.addAtPlayhead", "global", [], { c: "addMedia", overlay: false }),
  D("media.addOverlay", "global", [], { c: "addMedia", overlay: true }),

  D("marker.add", "global", ["M"], { c: "marker" }),
  D("marker.edit", "global", [], { c: "markerEdit" }),
  D("range.in", "global", ["I"], { c: "range", what: "in" }),
  D("range.out", "global", ["O"], { c: "range", what: "out" }),
  D("range.play", "global", ["Alt+P"], { c: "range", what: "play" }),
  D("range.loop", "global", [], { c: "range", what: "loop" }),
  D("range.clear", "global", ["Alt+X"], { c: "range", what: "clear" }),

  D("playhead.back", "canvas", ["Alt+ArrowLeft"], { c: "playhead", frames: -1 }),
  D("playhead.forward", "canvas", ["Alt+ArrowRight"], { c: "playhead", frames: 1 }),
  D("playhead.back30", "canvas", ["Alt+Shift+ArrowLeft"], { c: "playhead", frames: -30 }),
  D("playhead.forward30", "canvas", ["Alt+Shift+ArrowRight"], { c: "playhead", frames: 30 }),
  D("view.stepBack", "canvas", ["ArrowLeft"], { c: "step", frames: -1 }, { when: "noSelection" }),
  D("view.stepForward", "canvas", ["ArrowRight"], { c: "step", frames: 1 }, { when: "noSelection" }),
  D("view.secondBack", "canvas", ["Shift+ArrowLeft"], { c: "step", seconds: -1 }, { when: "noSelection" }),
  D("view.secondForward", "canvas", ["Shift+ArrowRight"], { c: "step", seconds: 1 }, { when: "noSelection" }),
  D("view.toStart", "canvas", ["Home"], { c: "step", to: "start" }),
  D("view.toEnd", "canvas", ["End"], { c: "step", to: "end" }),
  D("view.fullscreen", "global", ["F"], { c: "preview", what: "fullscreen" }),
  D("view.loop", "global", ["R"], { c: "preview", what: "loop" }),
  D("view.zoomIn", "canvas", ["+", "="], { c: "zoom", how: "in" }),
  D("view.zoomOut", "canvas", ["-", "_"], { c: "zoom", how: "out" }),
  D("view.zoomFit", "canvas", ["0"], { c: "zoom", how: "fit" }),
  D("view.zoomSelection", "canvas", ["Shift+Z"], { c: "zoom", how: "selection" }),
  D("view.pageRight", "canvas", ["PageDown"], { c: "scroll", how: "pageRight" }),
  D("view.pageLeft", "canvas", ["PageUp"], { c: "scroll", how: "pageLeft" }),
  D("view.tracksDown", "canvas", ["ArrowDown"], { c: "scroll", how: "down" }, { when: "noSelection" }),
  D("view.tracksUp", "canvas", ["ArrowUp"], { c: "scroll", how: "up" }, { when: "noSelection" }),

  D("transport.play", "transport", ["Space"], { c: "play" }, { fixed: true }),
  D("transport.reverse", "transport", ["J"], { c: "shuttle", key: "J" }, { fixed: true }),
  D("transport.pause", "transport", ["K"], { c: "shuttle", key: "K" }, { fixed: true }),
  D("transport.forward", "transport", ["L"], { c: "shuttle", key: "L" }, { fixed: true }),
  D("transport.stepBack", "transport", ["Comma", "ArrowLeft"], { c: "seek", frames: -1 }, { fixed: true }),
  D("transport.stepForward", "transport", ["Period", "ArrowRight"], { c: "seek", frames: 1 }, { fixed: true }),
  D("transport.toStart", "transport", ["Home"], { c: "seek", to: "start" }, { fixed: true }),
  D("transport.toEnd", "transport", ["End"], { c: "seek", to: "end" }, { fixed: true }),
];

const BY_ID = new Map(COMMANDS.map((d) => [d.id, d]));
export const commandById = (id: string): CommandDef | undefined => BY_ID.get(id);

// ---- chords ----

export interface KeyLike { key: string; code: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }

interface Chord { mod: boolean; shift: boolean; alt: boolean; main: string }

const MODIFIER_KEYS = new Set(["Control", "Meta", "Shift", "Alt", "AltGraph", "OS", "CapsLock"]);
export const isModifierKey = (key: string): boolean => MODIFIER_KEYS.has(key);

function parse(chord: string): Chord {
  const parts = chord.split("+");
  // "+" itself is a key: "Mod++" splits into [..., "", ""].
  let main = parts.pop() ?? "";
  if (main === "" && parts.length > 0 && parts[parts.length - 1] === "") { parts.pop(); main = "+"; }
  const has = (m: string) => parts.includes(m);
  return { mod: has("Mod"), shift: has("Shift"), alt: has("Alt"), main };
}

/** A single letter or digit is matched on the typed character, everything else on the key name or physical code. */
const isLetter = (s: string) => /^[a-z0-9]$/i.test(s);

function matches(c: Chord, e: KeyLike): boolean {
  if (c.mod !== (e.ctrlKey || e.metaKey)) return false;
  if (c.alt !== e.altKey) return false;
  const symbol = c.main.length === 1 && !isLetter(c.main); // Shift is how "+" is typed on many layouts: not part of the binding
  if (!symbol && c.shift !== e.shiftKey) return false;
  if (c.main.length === 1) return e.key.toLowerCase() === c.main.toLowerCase();
  return e.key === c.main || e.code === c.main;
}

/** The canonical chord of a key event (what the shortcut dialog records), or null for a bare modifier. */
export function chordOf(e: KeyLike): string | null {
  if (isModifierKey(e.key)) return null;
  const pre = `${e.ctrlKey || e.metaKey ? "Mod+" : ""}${e.altKey ? "Alt+" : ""}`;
  const named = /^(Comma|Period|BracketLeft|BracketRight|Space)$/.test(e.code) ? e.code : e.key === " " ? "Space" : e.key;
  const letter = named.length === 1 ? named.toUpperCase() : named;
  const symbol = letter.length === 1 && !isLetter(letter);
  return `${pre}${e.shiftKey && !symbol ? "Shift+" : ""}${letter}`;
}

const normal = (chord: string): string => {
  const c = parse(chord);
  return `${c.mod ? "Mod+" : ""}${c.alt ? "Alt+" : ""}${c.shift ? "Shift+" : ""}${c.main.length === 1 ? c.main.toUpperCase() : c.main}`;
};

// ---- keymaps ----

/** Command id -> chords. Only commands that differ from the registry defaults need an entry. */
export type Keymap = ReadonlyMap<string, readonly string[]>;

/** Presets re-bind a few commands the way another editor does. Named "like X"; no logos or assets of those products. Keys follow each editor's public shortcut list. */
export interface Preset { id: string; label: string; keys: Readonly<Record<string, readonly string[]>> }
export const PRESETS: readonly Preset[] = [
  { id: "default", label: "preset.default", keys: {} },
  { id: "capcut", label: "preset.capcut", keys: { "edit.split": ["Mod+B"], "clip.trimStartToPlayhead": ["Q"], "clip.trimEndToPlayhead": ["W"] } },
  { id: "premiere", label: "preset.premiere", keys: { "edit.split": ["Mod+K"], "clip.trimStartToPlayhead": ["Q"], "clip.trimEndToPlayhead": ["W"] } },
  { id: "finalcut", label: "preset.finalcut", keys: { "edit.split": ["Mod+B"], "clip.trimStartToPlayhead": ["Alt+BracketLeft"], "clip.trimEndToPlayhead": ["Alt+BracketRight"] } },
  { id: "resolve", label: "preset.resolve", keys: { "edit.split": ["Mod+B"], "clip.trimStartToPlayhead": ["Shift+BracketLeft"], "clip.trimEndToPlayhead": ["Shift+BracketRight"] } },
];

export interface KeymapSettings { preset: string; overrides: Readonly<Record<string, readonly string[]>> }
export const DEFAULT_SETTINGS: KeymapSettings = { preset: "default", overrides: {} };

/** Default keys, then the preset, then the user's own changes. A preset binding that reuses a default key of another command takes that key over (the other command loses it). */
export function buildKeymap(settings: KeymapSettings = DEFAULT_SETTINGS): Keymap {
  const map = new Map<string, readonly string[]>(COMMANDS.map((d) => [d.id, d.keys]));
  const preset = PRESETS.find((p) => p.id === settings.preset) ?? PRESETS[0]!;
  const apply = (layer: Readonly<Record<string, readonly string[]>>) => {
    for (const [id, keys] of Object.entries(layer)) {
      const def = BY_ID.get(id);
      if (!def || def.fixed) continue;
      const taken = new Set(keys.map(normal));
      for (const other of COMMANDS) {
        if (other.id === id || other.fixed || !overlaps(def, other)) continue;
        const have = map.get(other.id) ?? [];
        if (have.some((k) => taken.has(normal(k)))) map.set(other.id, have.filter((k) => !taken.has(normal(k))));
      }
      map.set(id, keys);
    }
  };
  apply(preset.keys);
  apply(settings.overrides);
  return map;
}

/** Two commands compete for a key when they can be live at the same time. */
function overlaps(a: CommandDef, b: CommandDef): boolean {
  if (a.context === "global" || b.context === "global") return true;
  if (a.context !== b.context) return false;
  return !a.when || !b.when || a.when === b.when;
}

/** The command a key event triggers in `context`, or null. `selection` says whether the timeline has a selection (it owns the plain arrows). */
export function resolveKey(e: KeyLike, context: Context, keymap: Keymap, selection = false): CommandDef | null {
  for (const d of COMMANDS) {
    if (d.context !== context) continue;
    if (d.when === "selection" && !selection) continue;
    if (d.when === "noSelection" && selection) continue;
    const keys = keymap.get(d.id) ?? d.keys;
    for (const k of keys) if (matches(parse(k), e)) return d;
  }
  return null;
}

export interface Conflict { chord: string; ids: string[] }

/** Chords bound twice by commands that can be live together (the arrows shared by `selection` / `noSelection` do not count). */
export function findConflicts(keymap: Keymap): Conflict[] {
  const seen = new Map<string, CommandDef[]>();
  for (const d of COMMANDS) for (const k of keymap.get(d.id) ?? d.keys) {
    const list = seen.get(normal(k)) ?? [];
    list.push(d);
    seen.set(normal(k), list);
  }
  const out: Conflict[] = [];
  for (const [chord, defs] of seen) {
    const clash = defs.filter((d, i) => defs.some((o, j) => j !== i && overlaps(d, o)));
    if (clash.length > 1) out.push({ chord, ids: clash.map((d) => d.id) });
  }
  return out;
}

/** Commands (other than `id`) that would clash if `chord` were added to `id`. */
export function conflictsFor(id: string, chord: string, keymap: Keymap): CommandDef[] {
  const me = BY_ID.get(id);
  if (!me) return [];
  const key = normal(chord);
  return COMMANDS.filter((o) => o.id !== id && overlaps(me, o) && (keymap.get(o.id) ?? o.keys).some((k) => normal(k) === key));
}

/** Give `chord` to `id` (replacing its keys) and take it from every command that would clash. Returns new settings. */
export function bind(settings: KeymapSettings, id: string, chord: string): KeymapSettings {
  const keymap = buildKeymap(settings);
  const overrides: Record<string, readonly string[]> = { ...settings.overrides, [id]: [chord] };
  for (const o of conflictsFor(id, chord, keymap)) overrides[o.id] = (keymap.get(o.id) ?? o.keys).filter((k) => normal(k) !== normal(chord));
  return { ...settings, overrides };
}

export const reset = (settings: KeymapSettings, id: string): KeymapSettings =>
  ({ ...settings, overrides: Object.fromEntries(Object.entries(settings.overrides).filter(([k]) => k !== id)) });

// ---- display ----

const NAMES: Record<string, string> = { Comma: ",", Period: ".", BracketLeft: "[", BracketRight: "]", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Space: "Space", Escape: "Esc", Delete: "Del" };
/** `Mod+Shift+Z` as shown to the user: Ctrl on most platforms, ⌘ on Apple ones. */
export function chordLabel(chord: string, apple = false): string {
  const c = parse(chord);
  const main = NAMES[c.main] ?? (c.main.length === 1 ? c.main.toUpperCase() : c.main);
  return [c.mod ? (apple ? "⌘" : "Ctrl") : "", c.alt ? (apple ? "⌥" : "Alt") : "", c.shift ? (apple ? "⇧" : "Shift") : "", main].filter(Boolean).join(apple ? "" : "+");
}
