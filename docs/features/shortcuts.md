# Command and shortcut registry (UX-03, M2-040)

## Behaviour
- One table of keyboard commands: `apps/web/src/commands/registry.ts` (`COMMANDS`: id, label key `cmd.<id>`, context, default chords, the command it runs, optional `when`). Pure data and pure functions; the timeline (`timeline/shortcuts.ts`) and the dialog are thin readers.
- Contexts: `global` (anywhere except typing in a field), `canvas` (timeline canvas focused), `transport` (the player's window-level keys). `when: selection | noSelection` says who owns the plain arrows.
- Chords: `Mod+Shift+Z`, `Alt+ArrowLeft`, `Comma`. `Mod` is Ctrl or Command. Letters match the typed character, named keys the key name or physical code (so Comma/Period/brackets work on every layout). Modifiers match exactly; Shift is ignored for symbol keys such as `+`.
- Presets re-bind a few commands on top of the defaults: "Like CapCut", "Like Premiere Pro", "Like Final Cut Pro", "Like DaVinci Resolve". Names only, no logos or assets. A preset key that another command held takes it over.
- User remap: menu "Keyboard shortcuts…" (dialog; each Change button >= 44 px, press the new keys, Esc cancels). A key held by a command that could be live at the same time asks "Replace?" first; Replace takes it from the other command. Reset per command and reset all.
- Stored in `localStorage` key `overcut.keymap` (`{preset, overrides}`), this device only, validated on load (unknown ids dropped). Storage unavailable = defaults.

## Not yet (open)
- Transport keys (Space, J K L, comma/period/arrows, Home/End) are listed but "fixed for now": `PreviewPanel.tsx` is lane B's file and still reads them itself. When lane B imports `resolveKey(e, "transport", currentKeymap())` the `fixed` flags go away.
- Command palette (M2-041) reads this registry; per-platform key labels for non-Latin layouts are not special-cased.

## Edge cases
- Same chord in `global` and `canvas`: conflict (global is live everywhere). Same chord in `canvas` and `transport` is not (different focus), e.g. Comma nudges a clip in the timeline and steps a frame in the player.
- Defaults and every preset are conflict-free (unit test).
- M2-045 adds the "Edit tools" group (V B N Y U) and ripple delete / close gap / slip / slide / roll by frame (`timeline-drag.md`).

## Test plan
- `tests/unit/commands.test.ts`: every pre-registry shortcut resolves as before, presets, bind/conflict/reset, chord recording and labels, settings validation, labels exist.
- `tests/smoke/shortcuts.spec.ts`: remap Split to Q, Q splits and S does not, clash asks, survives reload, preset switch.
- M2 a11y: `Mod+Alt+Left/Right` hop the selected clip over its neighbour (keyboard reorder, `hopStep`; Alt+Shift+Arrow is already the 30-frame playhead step), `Alt+Up/Down` change lane, track switches as commands (`Shift+M` mute, `Shift+H` hide; solo and lock have no default key because `Shift+L`/`Shift+S` belong to playback and split) plus the More menu's "Track options" for the same switches. The app menu focuses its first item on open, Up/Down/Home/End move, Escape returns focus to its button; the history and timing sheets restore focus like the other dialogs.
- M2-041 command palette: `Ctrl/Cmd+K` (command `app.palette`, remappable), a visible search button in the top bar (hidden under 480 px) and a "Commands" row at the top of the app menu. Lists every registry command except the player's own keys, labelled `cmd.<id>`, with its current key; type words (all must match, any order), arrows move, Enter runs, Esc closes. Recently run commands come first (stored locally, `overcut.palette.recent`). A command runs through `overcut:command` (the timeline canvas executes what it owns and forwards the rest), so the palette and the keys share one path. Works at 320 px (44 px input and rows). Tests: `tests/unit/palette.test.ts`, `tests/smoke/palette.spec.ts`.

## M2 UX additions
- Context menu key / Shift+F10 (timeline focused, a clip selected): clip menu. Palette only (no default key): "Add media at playhead", "Add as overlay on a new track".
- M2 UX r13 (#241): speed, opacity keyframe and export are registry commands (palette, shortcut dialog, remappable, key shown in the tooltips). `T` speed 2x, `Shift+T` 0.5x (`clip.speedNormal`, back to 1x, has no default key), `Shift+D` add or remove an opacity keyframe at the playhead (`opacityKeyOps`, the Details diamond's edit; "D" for diamond), `Ctrl/Cmd+E` open Export (`EXPORT_EVENT`, handled by the Export button; with nothing to export it says so). Speed and keyframe need a selection (palette: listed disabled with the reason). `Shift+J/K/L` are swallowed by the preview panel's transport keys (`/^[jkl]$/i`), so no default uses them.
