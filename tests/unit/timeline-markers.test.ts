/** Markers and the in/out range on the timeline (M2-046): planning, ruler hit-testing and the drag gesture. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Project } from "../../packages/engine-client/src";
import { fixtureProject } from "../../apps/web/src/timeline/fixture";
import { flagsOf } from "../../apps/web/src/timeline/edit";
import { IDLE, longPress, pointerDown, pointerMove, pointerUp, type Ctx, type PEvent } from "../../apps/web/src/timeline/interact";
import { addMarkerPlan, clearRangePlan, loopPlan, markerAt, rangePlan } from "../../apps/web/src/timeline/markers";
import { buildScene, TICKS_PER_SECOND as TPS } from "../../apps/web/src/timeline/scene";
import { GUTTER_WIDE, timeToX, type View } from "../../apps/web/src/timeline/view";

const base = fixtureProject({ tracks: 2, clipsPerTrack: 3 });
const withMarks = (f: (p: Project) => void) => { const p = structuredClone(base); f(p); return buildScene(p); };
const view = (): View => ({ pps: 40, scrollX: 0, scrollY: 0, width: 900, height: 400, gutter: GUTTER_WIDE });
const ev = (x: number, y: number, kind: PEvent["kind"] = "mouse"): PEvent => ({ x, y, kind, shift: false, additive: false });
const ctx = (scene: ReturnType<typeof buildScene>, playhead?: number): Ctx => ({ scene, view: view(), selected: new Set(), selFlags: flagsOf(scene, []), playhead });

test("the scene carries markers, range and loop from the sequence", () => {
  const sc = withMarks((p) => { const s = p.sequences[0]!; s.markers = [{ id: "a".repeat(32), time: 2 * TPS, name: "Intro", kind: "chapter", colour: "#ef4444" }]; s.range = { start: TPS, end: 3 * TPS }; s.loop_range = true; });
  assert.deepEqual(sc.markers.map((m) => [m.name, m.sec, m.chapter, m.colour]), [["Intro", 2, true, "#ef4444"]]);
  assert.deepEqual(sc.range, { start: TPS, end: 3 * TPS });
  assert.equal(sc.loop, true);
  assert.equal(buildScene(base).range, null);
});

test("add marker at the playhead (whole frame), none when one is already there", () => {
  const sc = buildScene(base);
  const plan = addMarkerPlan(sc, 3 * TPS + 5, "b".repeat(32));
  assert.equal(plan.ops.length, 1);
  assert.equal(plan.ops[0]!.op, "add_marker");
  const at = (plan.ops[0] as Extract<typeof plan.ops[0], { op: "add_marker" }>).marker.time;
  assert.equal(at % sc.frameTicks, 0);
  const again = buildScene({ ...base, sequences: [{ ...base.sequences[0]!, markers: [{ id: "b".repeat(32), time: at }] }] });
  assert.equal(addMarkerPlan(again, at, "c".repeat(32)).ops.length, 0);
});

test("in and out points: the other end stays, a crossing point pushes it out, looping is kept", () => {
  const sc = buildScene(base);
  const inn = rangePlan(sc, "start", 2 * TPS);
  assert.equal(inn.ops.length, 1);
  const r = (inn.ops[0] as Extract<typeof inn.ops[0], { op: "set_range" }>).range!;
  assert.equal(r.start, 2 * TPS);
  assert.ok(r.end > r.start);
  const ranged = withMarks((p) => { p.sequences[0]!.range = { start: TPS, end: 4 * TPS }; p.sequences[0]!.loop_range = true; });
  const out = rangePlan(ranged, "end", 2 * TPS).ops[0] as Extract<ReturnType<typeof rangePlan>["ops"][0], { op: "set_range" }>;
  assert.deepEqual(out.range, { start: TPS, end: 2 * TPS });
  assert.equal(out.looping, true);
  const cross = rangePlan(ranged, "end", 0).ops[0] as Extract<ReturnType<typeof rangePlan>["ops"][0], { op: "set_range" }>;
  assert.ok(cross === undefined || cross.range!.start < cross.range!.end);
  assert.equal(rangePlan(ranged, "start", TPS).ops.length, 0, "same range: nothing to do");
});

test("clear and loop need a range", () => {
  const sc = buildScene(base);
  assert.equal(clearRangePlan(sc).ops.length, 0);
  assert.equal(loopPlan(sc).ops.length, 0);
  const ranged = withMarks((p) => { p.sequences[0]!.range = { start: 0, end: TPS }; });
  assert.deepEqual(clearRangePlan(ranged).ops, [{ op: "set_range", sequence: ranged.sequenceId, range: null }]);
  assert.equal((loopPlan(ranged).ops[0] as { looping?: boolean }).looping, true);
});

test("markers on the ruler: 22 px grab zone on touch, 11 px with a mouse, never below the ruler", () => {
  const sc = withMarks((p) => { p.sequences[0]!.markers = [{ id: "a".repeat(32), time: 2 * TPS }]; });
  const x = timeToX(view(), 2);
  assert.equal(markerAt(sc, view(), x + 10, 10, false), 0);
  assert.equal(markerAt(sc, view(), x + 15, 10, false), -1);
  assert.equal(markerAt(sc, view(), x + 20, 10, true), 0);
  assert.equal(markerAt(sc, view(), x, 40, true), -1);
});

test("a tap on a marker jumps to it; tapping it again with the playhead there opens its menu; a long press opens it", () => {
  const sc = withMarks((p) => { p.sequences[0]!.markers = [{ id: "a".repeat(32), time: 2 * TPS }]; });
  const x = timeToX(view(), 2);
  const down = pointerDown(ctx(sc), ev(x, 10));
  assert.equal(down.g.k, "marker");
  assert.deepEqual(pointerUp(ctx(sc), down.g, ev(x, 10)).fx, { seek: 2 });
  assert.deepEqual(pointerUp(ctx(sc, 2 * TPS), down.g, ev(x, 10)).fx, { markerMenu: "a".repeat(32) });
  assert.deepEqual(longPress(ctx(sc), down.g)?.fx, { markerMenu: "a".repeat(32) });
  // An empty bit of ruler still scrubs.
  assert.equal(pointerDown(ctx(sc), ev(x + 100, 10)).g.k, "scrub");
});

test("dragging a marker moves it by whole frames as one op, and not onto a negative time", () => {
  const sc = withMarks((p) => { p.sequences[0]!.markers = [{ id: "a".repeat(32), time: 2 * TPS }]; });
  const x = timeToX(view(), 2);
  let g = pointerDown(ctx(sc), ev(x, 10)).g;
  g = pointerMove(ctx(sc), g, ev(x + 80, 10)).g;
  assert.equal(g.k, "marker");
  const up = pointerUp(ctx(sc), g, ev(x + 80, 10));
  assert.equal(up.fx.ops!.length, 1);
  const op = up.fx.ops![0] as { op: string; marker: string; time: number };
  assert.equal(op.op, "move_marker");
  assert.equal(op.time % sc.frameTicks, 0);
  assert.ok(Math.abs(op.time / TPS - 4) < 0.05);
  const left = pointerUp(ctx(sc), pointerMove(ctx(sc), pointerDown(ctx(sc), ev(x, 10)).g, ev(-500, 10)).g, ev(-500, 10));
  assert.ok((left.fx.ops![0] as { time: number }).time >= 0);
  assert.equal(pointerUp(ctx(sc), IDLE, ev(0, 0)).fx.ops, undefined);
});
