import assert from "node:assert/strict";
import { test } from "node:test";
import { closeStartGap, trimOp, deleteOps, fitsOnTrack, flagsOf, moveOps, moveRoom, neighbour, snapDelta, splitOps, splittable, trimRange, trimTarget } from "../../apps/web/src/timeline/edit";
import { fixtureProject } from "../../apps/web/src/timeline/fixture";
import { handleAt, HANDLE_MOUSE, HANDLE_TOUCH } from "../../apps/web/src/timeline/hit";
import { applySelect, IDLE, markPreview, pointerDown, pointerMove, pointerUp, type Ctx, type Gesture, type PEvent } from "../../apps/web/src/timeline/interact";
import { buildScene, TICKS_PER_SECOND } from "../../apps/web/src/timeline/scene";
import { canvasCommand, globalCommand, isModifierKey, type KeyLike } from "../../apps/web/src/timeline/shortcuts";
import { LANE, RULER, timeToX, type View } from "../../apps/web/src/timeline/view";

const project = fixtureProject({ tracks: 4, clipsPerTrack: 6 });
// Known source length (30 s) so source limits can be tested.
project.media[0]!.duration = 30 * TICKS_PER_SECOND;
// Clip 1 has 10 s of source before it, so its start can be trimmed outwards.
project.sequences[0]!.tracks[0]!.clips[1]!.source_in = 10 * TICKS_PER_SECOND;
const scene = buildScene(project);
const FT = scene.frameTicks;
const view = (o: Partial<View> = {}): View => ({ pps: 40, scrollX: 0, scrollY: 0, width: 900, height: 400, ...o });
const key = (o: Partial<KeyLike> & { key: string }): KeyLike => ({ code: "", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o });
const mouse = (x: number, y: number, o: Partial<PEvent> = {}): PEvent => ({ x, y, kind: "mouse", shift: false, additive: false, ...o });
const touch = (x: number, y: number): PEvent => ({ x, y, kind: "touch", shift: false, additive: false });
const cx = (i: number, v = view()) => timeToX(v, (scene.start[i]! + scene.end[i]!) / 2);
const cy = (track: number) => RULER + track * LANE + LANE / 2;
const ctx = (selected: number[] = [], v = view()): Ctx => ({ scene, view: v, selected: new Set(selected.map((i) => scene.id[i]!)), selFlags: flagsOf(scene, selected) });

test("frame ticks are exact and deltas snap to whole frames inside the limits", () => {
  assert.equal(FT, 23_520_000);
  assert.equal(snapDelta(FT * 2.4, -FT * 10, FT * 10, FT), FT * 2);
  assert.equal(snapDelta(FT * 50, -FT * 10, FT * 10, FT), FT * 10);
  assert.equal(snapDelta(-FT * 50, -FT * 10.5, FT * 10, FT), -FT * 10, "a limit that is not a whole frame rounds toward zero");
  assert.equal(snapDelta(FT, 0, FT / 2, FT), 0, "no whole frame of room means no move");
});

test("moving: room stops at neighbours that are not selected, and at zero", () => {
  const room = moveRoom(scene, [1]);
  assert.equal(room.left, scene.tStart[1]! - (scene.tStart[0]! + scene.tDur[0]!));
  assert.equal(room.right, scene.tStart[2]! - (scene.tStart[1]! + scene.tDur[1]!));
  assert.equal(moveRoom(scene, [0]).left, scene.tStart[0]!, "first clip may only go back to 0");
  // A selected neighbour moves with the clip, so it does not limit it.
  const both = moveRoom(scene, [1, 2]);
  assert.equal(both.right, scene.tStart[3]! - (scene.tStart[2]! + scene.tDur[2]!));
  assert.equal(moveRoom(scene, [5]).right, Infinity);
});

test("move ops are ordered so no step overlaps a clip that has not moved yet", () => {
  const right = moveOps(scene, [1, 2], FT * 3);
  assert.deepEqual(right.map((o) => (o as { clip: string }).clip), [scene.id[2], scene.id[1]]);
  const left = moveOps(scene, [1, 2], -FT * 3);
  assert.deepEqual(left.map((o) => (o as { clip: string }).clip), [scene.id[1], scene.id[2]]);
  assert.deepEqual(right[1], { op: "move", clip: scene.id[1], track: scene.trackId[0], start: scene.tStart[1]! + FT * 3 });
});

test("a clip fits another track of the same kind only where it does not overlap, never a locked or other-kind track", () => {
  const last = scene.trackFirst[1]! - 1; // last clip of track 0, nothing after it
  assert.equal(fitsOnTrack(scene, last, 0, 0), true);
  assert.equal(fitsOnTrack(scene, 0, 1, 0), false, "audio track");
  assert.equal(fitsOnTrack(scene, 0, 2, 0), false, "overlaps clips already on track 2 at the same time");
  assert.equal(fitsOnTrack(scene, 0, 2, 100 * TICKS_PER_SECOND), true);
  assert.equal(fitsOnTrack(scene, 0, 0, -1), false, "before 0");
  const locked = buildScene({ ...project, sequences: [{ ...project.sequences[0]!, tracks: project.sequences[0]!.tracks.map((t, i) => (i === 2 ? { ...t, locked: true } : t)) }] });
  assert.equal(fitsOnTrack(locked, 0, 2, 100 * TICKS_PER_SECOND), false);
});

test("trim ranges: neighbours, source length, speed, and one frame minimum", () => {
  const r0 = trimRange(scene, 0, "end");
  assert.equal(r0.min, scene.tStart[0]! + FT);
  assert.equal(r0.max, scene.tStart[1]!, "limited by the next clip");
  const last = scene.trackFirst[1]! - 1;
  assert.equal(trimRange(scene, last, "end").max, scene.tStart[last]! + (30 * TICKS_PER_SECOND - scene.tSrcIn[last]!), "limited by the source media when nothing follows");
  assert.equal(trimRange(scene, 0, "start").min, 0);
  const r1 = trimRange(scene, 1, "start");
  assert.equal(r1.min, scene.tStart[0]! + scene.tDur[0]!, "stops at the previous clip");
  assert.equal(r1.max, scene.tStart[1]! + scene.tDur[1]! - FT);
  assert.equal(trimRange(scene, 1, "end").max, scene.tStart[2]!);
  assert.equal(trimTarget(scene, 1, "end", scene.tStart[1]! + scene.tDur[1]! + FT * 0.4), scene.tStart[1]! + scene.tDur[1]!, "snaps to the frame grid");
  assert.equal(trimTarget(scene, 1, "end", 1e15), scene.tStart[2]!, "clamped to the neighbour");
  assert.equal(trimTarget(scene, 1, "start", 1e15), scene.tStart[1]! + scene.tDur[1]! - FT, "never below one frame");
});

test("split: only clips with a frame on both sides, selected ones when there is a selection, never on a locked track", () => {
  const mid = Math.round(((scene.start[0]! + scene.end[0]!) / 2) * TICKS_PER_SECOND / FT) * FT;
  assert.deepEqual(splittable(scene, mid, null), [0, scene.trackFirst[1]!, scene.trackFirst[2]!, scene.trackFirst[3]!].filter((i) => scene.start[i]! * TICKS_PER_SECOND < mid && scene.end[i]! * TICKS_PER_SECOND > mid));
  assert.deepEqual(splittable(scene, mid, [3]), [], "selected clip not under the playhead");
  assert.deepEqual(splittable(scene, scene.tStart[0]!, null).filter((i) => i === 0), [], "on a clip's first frame there is nothing to split");
  let n = 0;
  const ops = splitOps(scene, [0], mid, () => `id${n++}`);
  assert.deepEqual(ops, [{ op: "split", clip: scene.id[0], at: mid, new_id: "id0" }]);
  assert.deepEqual(deleteOps(scene, [0, 1]), [{ op: "delete", clip: scene.id[0] }, { op: "delete", clip: scene.id[1] }]);
});

test("keyboard navigation between clips", () => {
  assert.equal(neighbour(scene, 1, "right"), 2);
  assert.equal(neighbour(scene, 1, "left"), 0);
  assert.equal(neighbour(scene, 0, "left"), 0, "stays at the first clip");
  assert.equal(neighbour(scene, scene.trackFirst[1]! - 1, "right"), scene.trackFirst[1]! - 1, "does not leak into the next track");
  const down = neighbour(scene, 1, "down");
  assert.equal(scene.clipTrack[down], 1);
  assert.equal(neighbour(scene, 1, "up"), 1, "top track has nothing above");
});

test("hit zones for trim handles are at least 44 px wide for touch, even on a narrow clip, and only on selected clips", () => {
  const v = view({ pps: 3 }); // clips ~16 px wide
  const i = 4, sel = flagsOf(scene, [i]); // far enough from the gutter for the whole zone to be reachable
  const x0 = timeToX(v, scene.start[i]!), x1 = timeToX(v, scene.end[i]!), y = cy(0);
  assert.ok(x1 - x0 < 20);
  let lo = Infinity, hi = -Infinity;
  for (let x = x0 - 60; x <= x1 + 60; x += 0.5) {
    const h = handleAt(scene, v, sel, x, y, true);
    if (h?.edge === "start") { lo = Math.min(lo, x); hi = Math.max(hi, x); }
  }
  assert.ok(hi - lo >= HANDLE_TOUCH - 1, `start zone ${hi - lo}px`);
  assert.equal(handleAt(scene, v, sel, (x0 + x1) / 2, y, true), null, "a tiny clip keeps a third of its width as a body to grab");
  assert.equal(handleAt(scene, view(), flagsOf(scene, []), timeToX(view(), scene.start[i]!), y, true), null, "unselected clips have no handles");
  const wide = view();
  assert.equal(handleAt(scene, wide, flagsOf(scene, [i]), cx(i, wide), y, true), null, "the body of a wide clip is not a handle");
  assert.ok(HANDLE_MOUSE < HANDLE_TOUCH);
});

test("mouse: the edge of an unselected clip trims it and selects it; touch still needs a selection first", () => {
  const i = 4, v = view(), y = cy(0), x0 = timeToX(v, scene.start[i]!);
  const none = flagsOf(scene, []);
  assert.equal(handleAt(scene, v, none, x0, y, false), null);
  assert.deepEqual(handleAt(scene, v, none, x0, y, false, true), { clip: i, edge: "start" });
  const r = pointerDown(ctx(), mouse(x0, y));
  assert.equal(r.g.k, "trim");
  assert.deepEqual(r.fx.select, { mode: "set", ids: [scene.id[i]] });
  assert.notEqual(pointerDown(ctx(), touch(x0, y)).g.k, "trim");
});

test("click selects, shift/ctrl toggles, and a tap on empty space seeks and clears", () => {
  let r = pointerDown(ctx(), mouse(cx(1), cy(0)));
  assert.deepEqual(r.fx.select, { mode: "set", ids: [scene.id[1]] });
  assert.equal(r.g.k, "press");
  r = pointerUp(ctx([1]), r.g, mouse(cx(1), cy(0)));
  assert.equal(r.fx.ops, undefined, "a click is not an edit");
  r = pointerDown(ctx([1]), mouse(cx(2), cy(0), { shift: true }));
  assert.deepEqual(r.fx.select, { mode: "toggle", ids: [scene.id[2]] });
  assert.deepEqual([...applySelect(new Set([scene.id[1]!]), r.fx.select!)], [scene.id[1], scene.id[2]]);
  assert.deepEqual([...applySelect(new Set([scene.id[1]!, scene.id[2]!]), r.fx.select!)], [scene.id[1]]);
  const empty = timeToX(view(), scene.end[0]! + 0.3); // inside the gap after clip 0
  r = pointerDown(ctx([1]), mouse(empty, cy(0)));
  const up = pointerUp(ctx([1]), r.g, mouse(empty, cy(0)));
  assert.ok(up.fx.seek !== undefined && Math.abs(up.fx.seek - (scene.end[0]! + 0.3)) < 0.05);
  assert.deepEqual(up.fx.select, { mode: "set", ids: [] });
});

test("dragging a clip previews, clamps at neighbours, and commits ONE batch of ops on release", () => {
  const i = 1;
  const x = cx(i), y = cy(0);
  let r = pointerDown(ctx(), mouse(x, y));
  const c = ctx([i]); // the canvas applies the selection effect before the next event
  const g: Gesture = r.g;
  r = pointerMove(c, g, mouse(x + 2, y)); // inside the slop: still a press
  assert.equal(r.g.k, "press");
  r = pointerMove(c, r.g, mouse(x + 20, y));
  assert.equal(r.g.k, "move");
  const m = r.g as Extract<Gesture, { k: "move" }>;
  assert.equal(m.delta, snapDelta(0.5 * TICKS_PER_SECOND, 0, moveRoom(scene, [i]).right, FT));
  r = pointerMove(c, r.g, mouse(x + 4000, y)); // far right: clamped by the next clip
  assert.equal((r.g as Extract<Gesture, { k: "move" }>).delta, Math.floor(moveRoom(scene, [i]).right / FT) * FT);
  const done = pointerUp(c, r.g, mouse(x + 4000, y));
  assert.equal(done.fx.ops?.length, 1);
  assert.deepEqual(done.fx.ops![0], { op: "move", clip: scene.id[i], track: scene.trackId[0], start: scene.tStart[i]! + (r.g as Extract<Gesture, { k: "move" }>).delta });
  assert.equal(done.g.k, "idle");
});

test("dragging a single clip onto another track of the same kind moves it there; a blocked track leaves it where it was", () => {
  const i = scene.trackFirst[1]! - 1; // last video clip on track 0
  const x = cx(i), y = cy(0);
  const c = ctx([i]);
  const start = pointerDown(c, mouse(x, y)).g;
  const blocked = pointerMove(c, pointerMove(c, start, mouse(x + 10, y)).g, mouse(x + 10, cy(2)));
  assert.equal((blocked.g as Extract<Gesture, { k: "move" }>).track, 0, "overlaps clips on track 2 at this time");
  const audio = pointerMove(c, pointerMove(c, start, mouse(x + 10, y)).g, mouse(x + 10, cy(1)));
  assert.equal((audio.g as Extract<Gesture, { k: "move" }>).track, 0, "video clips do not go onto audio tracks");
});

test("touch: tapping an unselected clip selects it, dragging it pans, dragging a selected clip moves it", () => {
  const i = 1, x = cx(i), y = cy(0);
  let r = pointerDown(ctx(), touch(x, y));
  assert.equal(r.fx.select, undefined, "selection happens on release so a pan never selects");
  assert.equal(pointerUp(ctx(), r.g, touch(x, y)).fx.select?.ids[0], scene.id[i]);
  r = pointerMove(ctx(), r.g, touch(x + 30, y));
  assert.equal(r.g.k, "pan");
  r = pointerDown(ctx([i]), touch(x, y));
  assert.equal(pointerMove(ctx([i]), r.g, touch(x + 30, y)).g.k, "move");
  // empty space: tap seeks, drag pans
  const e = pointerDown(ctx(), touch(timeToX(view(), scene.end[0]! + 0.3), y));
  assert.equal(pointerMove(ctx(), e.g, touch(300, y)).g.k, "pan");
});

test("trim by dragging a handle: previews and commits one trim op; unchanged means no op", () => {
  const i = 1, c = ctx([i]), v = view();
  const xEnd = timeToX(v, scene.end[i]!), y = cy(0);
  let r = pointerDown(c, mouse(xEnd - 2, y));
  assert.equal(r.g.k, "trim");
  assert.equal(pointerUp(c, r.g, mouse(xEnd, y)).fx.ops, undefined);
  r = pointerMove(c, r.g, mouse(xEnd - 40, y));
  const t = r.g as Extract<Gesture, { k: "trim" }>;
  assert.equal(t.value, trimTarget(scene, i, "end", t.orig - (38 / 40) * TICKS_PER_SECOND));
  const done = pointerUp(c, r.g, mouse(xEnd - 40, y));
  assert.deepEqual(done.fx.ops, [{ op: "trim_out", clip: scene.id[i], end: t.value }]);
  const s = pointerDown(c, mouse(timeToX(v, scene.start[i]!) + 2, y));
  assert.equal((s.g as Extract<Gesture, { k: "trim" }>).edge, "start");
});

test("marquee selects every clip it touches; shift adds", () => {
  const empty = timeToX(view(), scene.end[0]! + 0.3);
  let r = pointerDown(ctx(), mouse(empty, cy(0) - 10));
  r = pointerMove(ctx(), r.g, mouse(timeToX(view(), scene.end[2]! - 0.1), cy(1)));
  assert.equal(r.g.k, "marquee");
  const up = pointerUp(ctx(), r.g, mouse(timeToX(view(), scene.end[2]! - 0.1), cy(1)));
  const want = [1, 2, scene.trackFirst[1]! + 1, scene.trackFirst[1]! + 2].map((i) => scene.id[i]);
  assert.ok(want.every((id) => up.fx.select!.ids.includes(id!)), `got ${up.fx.select!.ids.length}`);
  assert.equal(up.fx.select!.mode, "set");
  assert.equal(pointerUp(ctx(), r.g, mouse(500, 100, { shift: true })).fx.select!.mode, "add");
});

test("the ruler scrubs; a second pointer or a cancelled gesture leaves no edit behind", () => {
  const r = pointerDown(ctx(), mouse(300, 10));
  assert.equal(r.g.k, "scrub");
  assert.ok(r.fx.seek! > 0);
  assert.equal(pointerUp(ctx(), IDLE, mouse(0, 0)).fx.ops, undefined);
});

test("shortcuts: undo/redo/split/delete anywhere, selection keys only on the canvas", () => {
  assert.deepEqual(globalCommand(key({ key: "z", ctrlKey: true })), { c: "undo" });
  assert.deepEqual(globalCommand(key({ key: "Z", metaKey: true, shiftKey: true })), { c: "redo" });
  assert.deepEqual(globalCommand(key({ key: "y", ctrlKey: true })), { c: "redo" });
  assert.deepEqual(globalCommand(key({ key: "s" })), { c: "split" });
  assert.equal(globalCommand(key({ key: "s", ctrlKey: true })), null, "Ctrl+S is not split");
  assert.deepEqual(globalCommand(key({ key: "Delete" })), { c: "delete" });
  assert.deepEqual(globalCommand(key({ key: "Backspace" })), { c: "delete" });
  assert.deepEqual(canvasCommand(key({ key: "ArrowRight" }), true), { c: "go", dir: "right" });
  assert.deepEqual(canvasCommand(key({ key: "ArrowRight" }), false), { c: "step", frames: 1 }, "without a selection arrows move the playhead (stale: this used to be a null here and a switch in the canvas; the registry now owns it)");
  assert.deepEqual(canvasCommand(key({ key: "ArrowRight", altKey: true }), true), { c: "playhead", frames: 1 });
  assert.deepEqual(canvasCommand(key({ key: ",", code: "Comma" }), true), { c: "nudge", frames: -1 });
  assert.deepEqual(canvasCommand(key({ key: ">", code: "Period", shiftKey: true }), true), { c: "nudge", frames: 10 });
  assert.deepEqual(canvasCommand(key({ key: "≥", code: "Period", altKey: true }), true), { c: "trimBy", edge: "end", frames: 1 });
  assert.deepEqual(canvasCommand(key({ key: "[", code: "BracketLeft" }), true), { c: "trimToPlayhead", edge: "start" });
  assert.deepEqual(canvasCommand(key({ key: "a", ctrlKey: true }), false), { c: "selectAll" });
  assert.deepEqual(canvasCommand(key({ key: "Escape" }), true), { c: "clear" });
});

test("closing the start gap: deleting or start-trimming the first clips slides the rest left; other edits are left alone", () => {
  const all = [...Array(scene.clipCount).keys()];
  const t0 = Math.min(...all.map((i) => scene.tStart[i]!));
  const front = all.filter((i) => scene.tStart[i]! === t0), rest = all.filter((i) => scene.tStart[i]! !== t0);
  assert.ok(rest.length > 0);
  const next = Math.min(...rest.map((i) => scene.tStart[i]!));
  const out = closeStartGap(scene, deleteOps(scene, front));
  const moves = out.filter((o) => o.op === "move");
  assert.equal(out.length, front.length + rest.length, "every remaining clip gets one move");
  for (const o of moves) { if (o.op !== "move") continue; const i = rest.find((k) => scene.id[k] === o.clip)!; assert.equal(o.start, scene.tStart[i]! - (next - t0)); }
  assert.ok(moves.some((o) => o.op === "move" && o.start === t0), "the new first clip lands where the project started");
  const del = deleteOps(scene, rest.slice(0, 1));
  assert.deepEqual(closeStartGap(scene, del), del, "deleting something later leaves a deliberate gap alone");
  const mv = moveOps(scene, front, scene.frameTicks);
  assert.deepEqual(closeStartGap(scene, mv), mv, "a move is the user's own placement");
  const ft = scene.frameTicks, e = trimOp(scene, front[0]!, "end", scene.tStart[front[0]!]! + scene.tDur[front[0]!]! - ft);
  assert.deepEqual(closeStartGap(scene, [e]), [e], "an end trim never moves anything");
});

test("a modifier pressed alone is not keyboard use of the timeline (no focus frame over the whole stage)", () => {
  for (const key of ["Shift", "Control", "Alt", "Meta", "AltGraph"]) assert.equal(isModifierKey(key), true, key);
  for (const key of ["ArrowLeft", "s", "Delete", " ", "a"]) assert.equal(isModifierKey(key), false, key);
});

test("a drag clamped back to 0:00 makes no edit, and the clip is still painted afterwards (no stuck ghost flag)", () => {
  // The first clip starts at 0: dragging its body left can only come back to 0, which is no edit at all.
  const v = view(), x = cx(0, v), sel = [0];
  const c = ctx(sel, v);
  const flags = flagsOf(scene, sel);
  let r = pointerDown(c, mouse(x, cy(0)));
  assert.equal(r.g.k, "press");
  let g: Gesture = r.g;
  for (let k = 1; k <= 10; k++) {
    r = pointerMove(c, g, mouse(x - 10 * k, cy(0)));
    g = r.g;
    markPreview(flags, g); // what the canvas does on every pointer move
    assert.equal(g.k, "move");
    assert.ok(scene.tStart[0]! + (g as Extract<Gesture, { k: "move" }>).delta >= 0, "never a negative start");
  }
  assert.equal(flags[0], 2, "while dragged the clip is a ghost");
  r = pointerUp(c, g, mouse(x - 100, cy(0)));
  assert.equal(r.fx.ops, undefined, "clamped to 0 is no move: no op is sent");
  markPreview(flags, IDLE); // what the canvas does on release
  assert.deepEqual(flags, flagsOf(scene, sel), "the clip is back to plain selected, so it is painted again");
});

test("a trim that ends where it started also leaves the clip painted", () => {
  const v = view(), sel = [1], c = ctx(sel, v), flags = flagsOf(scene, sel);
  const x1 = timeToX(v, scene.end[1]!);
  let r = pointerDown(c, mouse(x1, cy(0)));
  assert.equal(r.g.k, "trim");
  markPreview(flags, r.g);
  r = pointerMove(c, r.g, mouse(x1, cy(0)));
  markPreview(flags, r.g);
  r = pointerUp(c, r.g, mouse(x1, cy(0)));
  assert.equal(r.fx.ops, undefined);
  markPreview(flags, IDLE);
  assert.deepEqual(flags, flagsOf(scene, sel));
});
