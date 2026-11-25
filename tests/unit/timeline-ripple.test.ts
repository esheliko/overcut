/** Ripple, roll, slip, slide (TL-04, M2-045): the UI's limits and op lists, and the gestures that start them. The engine side is tested in Rust. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { TICKS, mediaRef, type Probed } from "../../apps/web/src/media/plan";
import { pointerDown, pointerMove, pointerUp, type Ctx, type PEvent } from "../../apps/web/src/timeline/interact";
import { closeGapOps, cutAt, rippleDeleteOps, rippleRange, rippleTrimOps, rollCuts, rollOps, rollRangeAll, slideOps, slideRange, slipOps, slipRange, snapTo } from "../../apps/web/src/timeline/ripple";
import { handleAt } from "../../apps/web/src/timeline/hit";
import { flagsOf } from "../../apps/web/src/timeline/edit";
import { buildScene } from "../../apps/web/src/timeline/scene";
import { gut, LANE, RULER, type View } from "../../apps/web/src/timeline/view";
import { newProject } from "../../packages/engine-client/src/project";

const video: Probed = { kind: "video", durationTicks: 20 * TICKS, width: 1920, height: 1080, rotation: 0, fps: { num: 30, den: 1 }, hasAudio: false, hasVideo: true };
const sp = { num: 1, den: 1 };
const clip = (id: string, start: number, source_in: number, duration: number) => ({ id: id.padStart(32, "0"), media: "m1", start: start * TICKS, source_in: source_in * TICKS, duration: duration * TICKS, speed: sp });

/** V1: a 0-4 s (source 2-6), b 4-8 s (source 6-10) touching, c 10-12 s (source 0-2) after a 2 s gap. 20 s of media. */
function build() {
  const p = structuredClone(newProject("x"));
  p.media.push(mediaRef("m1", "v.mp4", "u", video, null));
  p.sequences[0]!.tracks[0]!.clips.push(clip("a", 0, 2, 4), clip("b", 4, 6, 4), clip("c", 10, 0, 2));
  return buildScene(p);
}
const scene = build();
const [A, B, C] = [0, 1, 2];
const sec = (s: number) => s * TICKS;
const ft = scene.frameTicks;

test("ripple range: a clip keeps a frame and stays inside its media; neighbours just shift", () => {
  const out = rippleRange(scene, A, "end")!;
  assert.equal(out.lo, -(sec(4) - ft));
  assert.equal(out.hi, sec(20) - sec(2) - sec(4)); // media 20 s, source_in 2 s, 4 s used
  const inn = rippleRange(scene, B, "start")!;
  assert.equal(inn.lo, -sec(6)); // 6 s of source before the clip
  assert.equal(inn.hi, sec(4) - ft);
  assert.deepEqual(rippleTrimOps(scene, A, "start", ft), [{ op: "ripple_trim", clip: scene.id[A], edge: "in", delta: ft }]);
  assert.equal(rippleTrimOps(scene, A, "end", -ft)[0]!.op, "ripple_trim");
});

test("roll: only a cut between touching clips; the range is the shorter of what each side can give", () => {
  assert.deepEqual(cutAt(scene, A, "end"), [A, B]);
  assert.deepEqual(cutAt(scene, B, "start"), [A, B]);
  assert.equal(cutAt(scene, B, "end"), null, "b ends before a gap");
  assert.equal(cutAt(scene, C, "start"), null);
  const cuts = rollCuts(scene, A, "end");
  const r = rollRangeAll(scene, cuts);
  assert.equal(r.lo, -(sec(4) - ft)); // a can shrink to a frame; b can reveal 6 s
  assert.equal(r.hi, sec(4) - ft); // b can shrink to a frame; a has 14 s of source after it
  assert.deepEqual(rollOps(scene, cuts, ft), [{ op: "roll", left: scene.id[A], right: scene.id[B], to: sec(4) + ft }]);
});

test("slip stays inside the media; slide is bounded by what touching neighbours can give and by walls", () => {
  const sa = slipRange(scene, A)!;
  assert.equal(sa.lo, -sec(2));
  assert.equal(sa.hi, sec(20) - sec(2) - sec(4));
  assert.deepEqual(slipOps(scene, A, ft), [{ op: "slip", clip: scene.id[A], delta: ft }]);
  const sb = slideRange(scene, B)!; // a touches on the left, a 2 s gap on the right
  assert.equal(sb.lo, -(sec(4) - ft));
  assert.equal(sb.hi, sec(2)); // up to c
  const sc = slideRange(scene, C)!; // gap on the left, nothing on the right
  assert.equal(sc.lo, -sec(2));
  assert.equal(sc.hi, Infinity);
  assert.deepEqual(slideOps(scene, B, -ft), [{ op: "slide", clip: scene.id[B], delta: -ft }]);
  assert.equal(snapTo(scene, ft * 3.4, { lo: -ft, hi: 2 * ft }), 2 * ft, "whole frames, clamped");
});

test("ripple delete and close gap", () => {
  assert.deepEqual(rippleDeleteOps(scene, [A, B]).map((o) => o.op), ["ripple_delete", "ripple_delete"]);
  assert.deepEqual(closeGapOps(scene, [C]), [{ op: "close_gap", track: scene.trackId[0], at: sec(9) }]);
  assert.deepEqual(closeGapOps(scene, [B]), [], "b touches a: no gap");
  assert.deepEqual(closeGapOps(scene, []), []);
});

// ---- gestures ----
const view: View = { pps: 100, scrollX: 0, scrollY: 0, width: 1200, height: 400 };
const ctx = (tool?: Ctx["tool"]): Ctx => ({ scene, view, selected: new Set(), selFlags: flagsOf(scene, []), tool });
const ev = (xSec: number, extra: Partial<PEvent> = {}): PEvent => ({ x: gut(view) + xSec * view.pps, y: RULER + LANE / 2, kind: "mouse", shift: false, additive: false, ...extra });

test("Alt on a cut rolls, on a free edge ripples, on a body slips (Shift slides); the drag ends in one op list", () => {
  const roll = pointerDown(ctx(), ev(4, { alt: true }));
  assert.equal(roll.g.k, "tool");
  assert.equal((roll.g as { tool: string }).tool, "roll");
  const moved = pointerMove(ctx(), roll.g, ev(4.5, { alt: true }));
  const up = pointerUp(ctx(), moved.g, ev(4.5, { alt: true }));
  assert.equal(up.fx.ops![0]!.op, "roll");
  assert.equal((up.fx.ops![0] as { to: number }).to, Math.round(sec(4.5) / ft) * ft);

  const ripple = pointerDown(ctx(), ev(8, { alt: true })); // b's end: no touching clip
  assert.equal((ripple.g as { tool: string }).tool, "ripple");
  const rup = pointerUp(ctx(), pointerMove(ctx(), ripple.g, ev(7, { alt: true })).g, ev(7, { alt: true }));
  assert.equal(rup.fx.ops![0]!.op, "ripple_trim");
  assert.equal((rup.fx.ops![0] as { delta: number }).delta, -Math.round(sec(1) / ft) * ft);

  const slip = pointerDown(ctx(), ev(2, { alt: true }));
  assert.equal((slip.g as { tool: string }).tool, "slip");
  const sup = pointerUp(ctx(), pointerMove(ctx(), slip.g, ev(2.5, { alt: true })).g, ev(2.5, { alt: true }));
  assert.equal(sup.fx.ops![0]!.op, "slip");
  assert.ok((sup.fx.ops![0] as { delta: number }).delta < 0, "dragging right shows earlier source");

  assert.equal((pointerDown(ctx(), ev(2, { alt: true, shift: true })).g as { tool: string }).tool, "slide");
});

test("the toolbar tool does the same without a key; with the select tool and no Alt nothing changes", () => {
  assert.equal((pointerDown(ctx("slide"), ev(2)).g as { tool: string }).tool, "slide");
  assert.equal((pointerDown(ctx("ripple"), ev(8)).g as { tool: string }).tool, "ripple");
  assert.equal(pointerDown(ctx("roll"), ev(8)).g.k !== "tool", true, "no touching clip on b's right edge falls back to the normal press");
  assert.notEqual(pointerDown(ctx(), ev(2)).g.k, "tool");
});

test("a fresh import has no spare footage: Alt-drag slip / roll say why, visibly, instead of doing nothing", () => {
  const p = structuredClone(newProject("x"));
  p.media.push(mediaRef("m1", "v.mp4", "u", video, null));
  // Two touching clips that use ALL of their media (20 s each, source 0-20), like two fresh imports side by side.
  p.sequences[0]!.tracks[0]!.clips.push(clip("a", 0, 0, 20), clip("b", 20, 0, 20));
  const fresh = buildScene(p);
  const c: Ctx = { scene: fresh, view, selected: new Set(), selFlags: flagsOf(fresh, []) };
  const slip = pointerDown(c, ev(5, { alt: true }));
  assert.equal(slip.g.k, "idle");
  assert.deepEqual(slip.fx.say, { key: "timeline.say.noRoom.slip" });
  assert.equal(slip.fx.visible, true);
  assert.equal(pointerDown(c, ev(20, { alt: true })).fx.say?.key, "timeline.say.noRoom.roll"); // the cut between them
});

test("on a shared edge the pointer's side picks the clip: left of the cut trims the left clip's end, right of it the right clip's start", () => {
  const none = flagsOf(scene, []);
  const y = RULER + LANE / 2;
  const at = (xSec: number) => handleAt(scene, view, none, gut(view) + xSec * view.pps, y, false, true);
  assert.deepEqual(at(3.97), { clip: A, edge: "end" });
  assert.deepEqual(at(4.03), { clip: B, edge: "start" });
});
