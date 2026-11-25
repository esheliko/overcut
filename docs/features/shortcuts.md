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
