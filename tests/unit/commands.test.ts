import assert from "node:assert/strict";
import { test } from "node:test";
import en from "../../apps/web/src/i18n/en.json" with { type: "json" };
import { parseSettings } from "../../apps/web/src/commands/keymap";
import { COMMANDS, DEFAULT_SETTINGS, PRESETS, bind, buildKeymap, chordLabel, chordOf, conflictsFor, findConflicts, reset, resolveKey, type KeyLike } from "../../apps/web/src/commands/registry";

const key = (o: Partial<KeyLike>): KeyLike => ({ key: "", code: "", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o });
const defaults = buildKeymap();
const id = (e: Partial<KeyLike>, ctx: "global" | "canvas" | "transport", sel = false) => resolveKey(key(e), ctx, defaults, sel)?.id ?? null;

test("registry: ids are unique, every command has a label, defaults have no conflicts", () => {
  assert.equal(new Set(COMMANDS.map((d) => d.id)).size, COMMANDS.length);
  for (const d of COMMANDS) assert.ok((en as Record<string, string>)[d.label], `missing label ${d.label}`);
  for (const p of PRESETS) assert.ok((en as Record<string, string>)[p.label], `missing label ${p.label}`);
  assert.deepEqual(findConflicts(defaults), []);
  for (const p of PRESETS) assert.deepEqual(findConflicts(buildKeymap({ preset: p.id, overrides: {} })), [], p.id);
});

test("the default keys resolve exactly as the shortcuts did before the registry", () => {
  assert.equal(id({ key: "z", ctrlKey: true }, "global"), "edit.undo");
  assert.equal(id({ key: "Z", metaKey: true, shiftKey: true }, "global"), "edit.redo");
  assert.equal(id({ key: "y", ctrlKey: true }, "global"), "edit.redo");
  assert.equal(id({ key: "s" }, "global"), "edit.split");
  assert.equal(id({ key: "S", shiftKey: true }, "global"), null, "Shift+S is not split");
  assert.equal(id({ key: "s", ctrlKey: true }, "global"), null);
  assert.equal(id({ key: "c", ctrlKey: true, shiftKey: true }, "global"), null);
  assert.equal(id({ key: "c", ctrlKey: true, altKey: true }, "global"), null);
  assert.equal(id({ key: "c" }, "global"), null);
  assert.equal(id({ key: "Backspace" }, "global"), "edit.delete");
  assert.equal(id({ key: "ArrowRight" }, "canvas", true), "select.right");
  assert.equal(id({ key: "ArrowRight", shiftKey: true }, "canvas", true), "select.right");
  assert.equal(id({ key: "ArrowRight" }, "canvas", false), "view.stepForward");
  assert.equal(id({ key: "ArrowRight", shiftKey: true }, "canvas", false), "view.secondForward");
  assert.equal(id({ key: "ArrowRight", altKey: true }, "canvas", true), "playhead.forward");
  assert.equal(id({ key: "ArrowLeft", altKey: true, shiftKey: true }, "canvas", false), "playhead.back30");
  assert.equal(id({ key: "ArrowDown" }, "canvas", false), "view.tracksDown");
  assert.equal(id({ key: ">", code: "Period", shiftKey: true }, "canvas", true), "clip.nudgeForward10");
  assert.equal(id({ key: "≥", code: "Period", altKey: true }, "canvas", true), "clip.trimEndForward");
  assert.equal(id({ key: "<", code: "Comma", altKey: true, shiftKey: true }, "canvas", true), "clip.trimStartBack");
  assert.equal(id({ key: "[", code: "BracketLeft" }, "canvas", true), "clip.trimStartToPlayhead");
  assert.equal(id({ key: "+", shiftKey: true }, "canvas"), "view.zoomIn", "+ is typed with Shift");
  assert.equal(id({ key: "=" }, "canvas"), "view.zoomIn");
  assert.equal(id({ key: "-" }, "canvas"), "view.zoomOut");
  assert.equal(id({ key: "0" }, "canvas"), "view.zoomFit");
  assert.equal(id({ key: "PageDown" }, "canvas"), "view.pageRight");
  assert.equal(id({ key: "a", ctrlKey: true }, "canvas"), "select.all");
  assert.equal(id({ key: " ", code: "Space" }, "transport"), "transport.play");
  assert.equal(id({ key: "j" }, "transport"), "transport.reverse");
});

test("presets move a few keys and take them from whoever had them", () => {
  const premiere = buildKeymap({ preset: "premiere", overrides: {} });
  assert.equal(resolveKey(key({ key: "k", ctrlKey: true }), "global", premiere)?.id, "edit.split");
  assert.equal(resolveKey(key({ key: "s" }), "global", premiere), null, "the old key is free");
  assert.equal(resolveKey(key({ key: "q" }), "canvas", premiere)?.id, "clip.trimStartToPlayhead");
  for (const p of PRESETS) assert.ok(p.id === "default" || /^preset\./.test(p.label));
  // an unknown preset falls back to the defaults
  assert.equal(buildKeymap({ preset: "nope", overrides: {} }).get("edit.split")?.[0], "S");
});

test("remap: bind, conflict detection, replace and reset", () => {
  const free = bind(DEFAULT_SETTINGS, "edit.split", "Q");
  assert.equal(resolveKey(key({ key: "q" }), "global", buildKeymap(free))?.id, "edit.split");
  assert.equal(resolveKey(key({ key: "s" }), "global", buildKeymap(free)), null);
  // Ctrl+Z belongs to undo: asking for it reports undo, binding it takes it from undo
  assert.deepEqual(conflictsFor("edit.split", "Mod+Z", defaults).map((d) => d.id), ["edit.undo"]);
  const taken = bind(DEFAULT_SETTINGS, "edit.split", "Mod+Z");
  const km = buildKeymap(taken);
  assert.equal(resolveKey(key({ key: "z", ctrlKey: true }), "global", km)?.id, "edit.split");
  assert.deepEqual(findConflicts(km), []);
  assert.equal(km.get("edit.undo")?.length, 0);
  // commands in different contexts do not compete: Comma is a canvas nudge and a transport step
  assert.deepEqual(conflictsFor("clip.nudgeBack", "Comma", defaults).map((d) => d.id), []);
  // a global key does compete with a canvas one
  assert.deepEqual(conflictsFor("edit.split", "Escape", defaults).map((d) => d.id), ["select.clear"]);
  assert.deepEqual(buildKeymap(reset(free, "edit.split")).get("edit.split"), ["S"]);
  // transport keys are fixed until the preview panel reads the registry
  assert.deepEqual(buildKeymap({ preset: "default", overrides: { "transport.play": ["Q"] } }).get("transport.play"), ["Space"]);
});

test("chordOf records what the user pressed; chordLabel shows it per platform", () => {
  assert.equal(chordOf(key({ key: "Shift" })), null);
  assert.equal(chordOf(key({ key: "z", ctrlKey: true })), "Mod+Z");
  assert.equal(chordOf(key({ key: "Z", metaKey: true, shiftKey: true })), "Mod+Shift+Z");
  assert.equal(chordOf(key({ key: ">", code: "Period", shiftKey: true })), "Shift+Period");
  assert.equal(chordOf(key({ key: "+", shiftKey: true })), "+");
  assert.equal(chordOf(key({ key: " ", code: "Space" })), "Space");
  assert.equal(chordLabel("Mod+Shift+Z"), "Ctrl+Shift+Z");
  assert.equal(chordLabel("Mod+Shift+Z", true), "⌘⇧Z");
  assert.equal(chordLabel("Alt+ArrowLeft"), "Alt+←");
});

test("saved settings are validated: junk and unknown ids are dropped", () => {
  assert.deepEqual(parseSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(parseSettings({ preset: "x", overrides: { "edit.split": ["Q"], "nope": ["A"], "edit.undo": [3] } }), { preset: "default", overrides: { "edit.split": ["Q"] } });
  assert.equal(parseSettings({ preset: "resolve" }).preset, "resolve");
});
