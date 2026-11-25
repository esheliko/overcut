/** Command palette (M2-041): what it lists, how it ranks, and the recent list. */
import assert from "node:assert/strict";
import { test } from "node:test";
import en from "../../apps/web/src/i18n/en.json" with { type: "json" };
import { whyNot } from "../../apps/web/src/commands/availability";
import { PALETTE_COMMANDS, RECENT_MAX, pushRecent, searchCommands } from "../../apps/web/src/commands/palette";

const label = (id: string): string => (en as Record<string, string>)[`cmd.${id}`] ?? id;
const ids = (q: string, recent: string[] = []) => searchCommands(q, label, recent).map((d) => d.id);

test("every listed command has a label; the player's keys and the palette itself are not listed", () => {
  for (const d of PALETTE_COMMANDS) assert.ok((en as Record<string, string>)[`cmd.${d.id}`], `label for ${d.id}`);
  assert.ok(PALETTE_COMMANDS.every((d) => d.context !== "transport" && d.id !== "app.palette"));
  assert.ok(PALETTE_COMMANDS.some((d) => d.id === "edit.split"));
});

test("typed words must all match, in any order and case; nothing matches gibberish", () => {
  assert.ok(ids("split").includes("edit.split"));
  assert.ok(ids("TOOL RIPPLE").includes("tool.ripple"), "any order: 'Ripple trim tool'");
  assert.deepEqual(ids("zzzzqq"), []);
});

test("labels that start with the query come first; recent ones lead with no query", () => {
  const r = ids("zoom");
  assert.ok(r.length >= 3);
  assert.equal(label(r[0]!).toLowerCase().startsWith("zoom"), true);
  const all = ids("");
  assert.equal(all.length, PALETTE_COMMANDS.length);
  assert.deepEqual(ids("", ["tool.slip", "edit.split"]).slice(0, 2), ["tool.slip", "edit.split"], "most recent first");
});

test("recents: moved to the front, no duplicates, capped", () => {
  assert.deepEqual(pushRecent(["a", "b", "c"], "b"), ["b", "a", "c"]);
  assert.equal(pushRecent(Array.from({ length: RECENT_MAX }, (_, i) => `x${i}`), "new").length, RECENT_MAX);
});

test("commands that cannot run now sort below the runnable ones and say why", () => {
  const a = { canUndo: false, canRedo: true, selected: 0, copied: false };
  const r = searchCommands("", label, [], undefined, (d) => whyNot(d, a)).map((d) => d.id);
  assert.ok(r.indexOf("edit.redo") < r.indexOf("edit.undo"), "redo runs, undo does not");
  assert.ok(r.indexOf("edit.split") < r.indexOf("edit.delete"));
  assert.equal(whyNot(PALETTE_COMMANDS.find((d) => d.id === "edit.undo")!, a), "palette.why.undo");
  assert.equal(whyNot(PALETTE_COMMANDS.find((d) => d.id === "edit.delete")!, { ...a, selected: 2 }), null);
  for (const k of ["undo", "redo", "select", "paste"]) assert.ok((en as Record<string, string>)[`palette.why.${k}`]);
});
