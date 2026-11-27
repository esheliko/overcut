import assert from "node:assert/strict";
import { test } from "node:test";
import { hopOps, planHop, snapDrop, snapMove, SNAP_PX } from "../../apps/web/src/timeline/arrange";
import { moveRoom } from "../../apps/web/src/timeline/edit";
import { fixtureProject } from "../../apps/web/src/timeline/fixture";
import { IDLE, longPress, markPreview, pointerDown, pointerMove, pointerUp, type Ctx, type PEvent } from "../../apps/web/src/timeline/interact";
import { buildScene, TICKS_PER_SECOND as TPS } from "../../apps/web/src/timeline/scene";
import { flagsOf } from "../../apps/web/src/timeline/edit";
import { timeToX, RULER, LANE, type View } from "../../apps/web/src/timeline/view";

// Track 0 (video): six clips with quarter-length gaps; track 1 (audio) the same shape.
const scene = buildScene(fixtureProject({ tracks: 2, clipsPerTrack: 6 }));
const end = (i: number) => scene.tStart[i]! + scene.tDur[i]!;

test("snapMove pulls an edge onto a neighbour's edge, the playhead and 0:00, and reports the guide", () => {
  const gap = scene.tStart[1]! - end(0);
  // Clip 1 moved left to within 3 ticks of clip 0's end snaps flush against it.
  const near = snapMove(scene, [1], -gap + 3, -gap, gap, null, 100);
  assert.equal(near.delta, -gap);
  assert.equal(near.guide, end(0));
  // Far from everything: unchanged, no guide.
  const far = snapMove(scene, [1], -Math.floor(gap / 2), -gap, gap, null, 5);
  assert.equal(far.guide, null);
  assert.equal(far.delta, -Math.floor(gap / 2));
  // The playhead is a target too.
  const head = Math.round(scene.tStart[1]! + 2 * TPS);
  const toHead = snapMove(scene, [1], 2 * TPS + 10, -gap, 4 * TPS, head, 50);
  assert.equal(toHead.guide, head);
  assert.equal(scene.tStart[1]! + toHead.delta, head);
});

test("snapMove never leaves the allowed room", () => {
  const room = moveRoom(scene, [1]);
  const r = snapMove(scene, [1], room.right, -room.left, room.right, null, 10 * TPS);
  assert.ok(r.delta >= -room.left && r.delta <= room.right);
});

test("snapDrop lands on an edge within reach, otherwise on a whole frame", () => {
  const ft = scene.frameTicks;
  assert.deepEqual(snapDrop(scene, end(2) + 5, null, 50, ft), { delta: end(2), guide: end(2) });
  const free = snapDrop(scene, end(2) + 2.4 * ft + Math.floor(ft * 0.3), null, 1, ft);
  assert.equal(free.guide, null);
  assert.equal(free.delta % ft, 0);
  assert.equal(snapDrop(scene, -500, null, 1, ft).delta, 0, "never before 0:00");
});

test("planHop: past a neighbour's middle the clip jumps it; short of the middle it only slides", () => {
  const mid = scene.tStart[2]! + scene.tDur[2]! / 2;
  assert.equal(planHop(scene, [1], mid - end(1) - 5, 1), null);
  const hop = planHop(scene, [1], mid - end(1) + 5, 1)!;
  assert.equal(hop.n, 1);
  assert.equal(hop.shift, scene.tDur[2]!);
  // Two neighbours when the drag passes the second middle as well.
  const mid3 = scene.tStart[3]! + scene.tDur[3]! / 2;
  assert.equal(planHop(scene, [1], mid3 - end(1) + 5, 1)!.n, 2);
  // And to the left.
  const left = planHop(scene, [2], scene.tStart[1]! + scene.tDur[1]! / 2 - scene.tStart[2]! - 5, 2)!;
  assert.equal(left.n, -1);
  assert.equal(left.shift, -scene.tDur[1]!);
});

test("planHop: no neighbour, or an unselected clip between selected ones, means no hop", () => {
  assert.equal(planHop(scene, [5], 100 * TPS, 5), null, "nothing after the last clip");
  assert.equal(planHop(scene, [0, 2], 100 * TPS, 0), null, "clip 1 sits between the selection");
  assert.equal(planHop(scene, [1], 0, 1), null);
});

test("hopOps: parks the jumped clip, shifts the selection, settles the jumped clip where the selection was; replays to a reordered track", () => {
  const ops = hopOps(scene, [1], 1);
  assert.equal(ops.length, 3);
  // Replay the ops on a copy of track 0 and check the final layout: clip 2, then clip 1, no overlaps.
  const at = new Map<string, number>();
  for (let i = 0; i < scene.clipCount; i++) at.set(scene.id[i]!, scene.tStart[i]!);
  for (const op of ops) { assert.equal(op.op, "move"); at.set((op as { clip: string }).clip, (op as { start: number }).start); }
  assert.equal(at.get(scene.id[2]!), scene.tStart[1]!, "the jumped clip takes the selection's old start");
  assert.equal(at.get(scene.id[1]!), scene.tStart[1]! + scene.tDur[2]!);
  assert.ok(at.get(scene.id[1]!)! + scene.tDur[1]! <= scene.tStart[3]!, "does not run into the clip after");
  // The first op parks the jumped clip past everything, so no intermediate step overlaps.
  assert.ok((ops[0] as { start: number }).start > end(5));
});

test("hopOps to the left mirrors it", () => {
  const ops = hopOps(scene, [2], -1);
  const at = new Map<string, number>();
  for (let i = 0; i < scene.clipCount; i++) at.set(scene.id[i]!, scene.tStart[i]!);
  for (const op of ops) at.set((op as { clip: string }).clip, (op as { start: number }).start);
  assert.equal(at.get(scene.id[2]!), scene.tStart[2]! - scene.tDur[1]!);
  assert.equal(at.get(scene.id[1]!), end(2) - scene.tDur[1]!, "the jumped clip ends where the selection ended");
});

const view: View = { pps: 40, scrollX: 0, scrollY: 0, width: 900, height: 400 };
const mouse = (x: number, y: number): PEvent => ({ x, y, kind: "mouse", shift: false, additive: false });
const ctx = (sel: number[]): Ctx => ({ scene, view, selected: new Set(sel.map((i) => scene.id[i]!)), selFlags: flagsOf(scene, sel), playhead: null });
const cx = (i: number) => timeToX(view, (scene.start[i]! + scene.end[i]!) / 2);
const row = RULER + LANE / 2;

test("dragging a clip over its neighbour reorders it as ONE edit, and the gesture carries a guide", () => {
  const c = ctx([1]);
  let r = pointerDown(c, mouse(cx(1), row));
  const target = cx(2) + 10;
  r = pointerMove(c, r.g, mouse(target, row));
  assert.equal(r.g.k, "move");
  if (r.g.k !== "move") return;
  assert.equal(r.g.hop, 1);
  assert.ok(r.g.guide != null);
  const up = pointerUp(c, r.g, mouse(target, row));
  assert.equal(up.fx.ops?.length, 3, "park, shift, settle: one batch, so one undo step");
});

test("a short drag still slides and snaps (no hop)", () => {
  const c = ctx([1]);
  let r = pointerDown(c, mouse(cx(1), row));
  r = pointerMove(c, r.g, mouse(cx(1) + 20, row));
  assert.equal(r.g.k === "move" ? r.g.hop : -1, 0);
});

test("long press picks up an unselected clip for a touch; other gestures are untouched", () => {
  const c = ctx([]);
  const down = pointerDown(c, { x: cx(1), y: row, kind: "touch", shift: false, additive: false });
  assert.equal(down.g.k, "press");
  const lp = longPress(c, down.g)!;
  assert.deepEqual(lp.fx.select, { mode: "set", ids: [scene.id[1]!] });
  assert.equal(lp.g.k === "press" ? lp.g.then : "", "move");
  assert.equal(lp.g.k === "press" ? lp.g.lifted : false, true); // drawn lifted (as its ghost) until the finger moves or lets go
  assert.ok(!(down.g.k === "press" && down.g.lifted)); // a plain press is not
  const flags = new Uint8Array(scene.id.length);
  markPreview(flags, lp.g);
  assert.equal(flags[1], 2);
  markPreview(flags, IDLE);
  assert.equal(flags[1], 1); // settled: a lifted 2 goes back to 1 (visible, selected)
  assert.equal(longPress(c, IDLE), null);
});

test("SNAP_PX is a fingertip-friendly reach", () => assert.ok(SNAP_PX >= 6 && SNAP_PX <= 12));

test("sameLayout: a rebuilt but identical scene keeps a drag alive; any moved clip does not", async () => {
  const { sameLayout } = await import("../../apps/web/src/timeline/interact");
  const again = buildScene(fixtureProject({ tracks: 2, clipsPerTrack: 6 }));
  assert.equal(sameLayout(scene, again), true);
  const other = buildScene(fixtureProject({ tracks: 2, clipsPerTrack: 5 }));
  assert.equal(sameLayout(scene, other), false);
  const shifted = buildScene(fixtureProject({ tracks: 2, clipsPerTrack: 6, clipSec: 5 }));
  assert.equal(sameLayout(scene, shifted), false);
});

test("snapMove snaps to markers and the in/out points, with the guide", () => {
  const sc = structuredClone(scene);
  sc.markers = [{ id: "m", ticks: 1 * TPS, sec: 1, name: "", colour: null, chapter: false }];
  sc.range = { start: 20 * TPS, end: 30 * TPS };
  const s = sc.tStart[1]!;
  const toMarker = snapMove(sc, [1], 1 * TPS - s + 3, -s, 100 * TPS, null, 50);
  assert.equal(toMarker.guide, 1 * TPS);
  assert.equal(s + toMarker.delta, 1 * TPS);
  const toIn = snapMove(sc, [1], 20 * TPS - s - 4, -s, 100 * TPS, null, 50);
  assert.equal(toIn.guide, 20 * TPS);
});
