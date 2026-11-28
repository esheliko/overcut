import assert from "node:assert/strict";
import { test } from "node:test";
import { EASE_IN_OUT, LINEAR, HOLD, clipKeyTimes, easingId, easingOps, evalAnimated, keyState, neighbourKey, setKeyOps, toggleKeyOps, groupKeyOps, TRANSFORM_GROUP } from "../../apps/web/src/inspector/keyframeModel";
import { isIdentity, snapMove, snapRotation, valuesOf } from "../../apps/web/src/inspector/transformModel";

const anim = { value: 0, keys: [{ t: 0, v: 0, easing: LINEAR }, { t: 1000, v: 100, easing: HOLD }, { t: 2000, v: 50 }] };

test("evalAnimated matches the engine: end values hold, linear blends, hold steps, a missing easing is linear", () => {
  assert.equal(evalAnimated(anim, 0, -5), 0);
  assert.equal(evalAnimated(anim, 0, 500), 50);
  assert.equal(evalAnimated(anim, 0, 1500), 100);
  assert.equal(evalAnimated(anim, 0, 9999), 50);
  assert.equal(evalAnimated({ value: 7 }, 0, 123), 7);
  assert.equal(evalAnimated(undefined, 3, 1), 3);
  const eased = { value: 0, keys: [{ t: 0, v: 0, easing: EASE_IN_OUT }, { t: 1000, v: 1 }] };
  assert.ok(Math.abs(evalAnimated(eased, 0, 500) - 0.5) < 1e-9, "ease in-out is symmetric");
  assert.ok(evalAnimated(eased, 0, 250) < 0.25, "ease in-out starts slow");
});

test("key state, neighbours and the playhead tolerance", () => {
  assert.equal(keyState({ value: 1 }, 10, 5), "none");
  assert.equal(keyState(anim, 1003, 5), "on");
  assert.equal(keyState(anim, 1500, 5), "between");
  assert.equal(neighbourKey(anim, 1000, 5, -1), 0);
  assert.equal(neighbourKey(anim, 1000, 5, 1), 2000);
  assert.equal(neighbourKey(anim, 0, 5, -1), undefined);
  assert.equal(neighbourKey(anim, 2000, 5, 1), undefined);
});

test("easing names round-trip through the stored numbers", () => {
  assert.equal(easingId(undefined), "linear");
  assert.equal(easingId(EASE_IN_OUT), "ease-in-out");
  assert.equal(easingId(HOLD), "hold");
  assert.equal(easingId({ kind: "bezier", x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4 }), "custom");
});

test("the diamond adds a key at the playhead with the current value, removes it, and keeps the value when the last key goes", () => {
  const tr = { opacity: { value: 0.8 } };
  assert.deepEqual(toggleKeyOps("c", tr, ["opacity"], 100, 5, 1), [{ op: "set_keyframe", clip: "c", prop: "opacity", key: { t: 100, v: 0.8, easing: LINEAR } }]);
  const two = { opacity: { value: 0.8, keys: [{ t: 0, v: 0.2 }, { t: 100, v: 0.9 }] } };
  assert.deepEqual(toggleKeyOps("c", two, ["opacity"], 102, 5, 1), [{ op: "delete_keyframe", clip: "c", prop: "opacity", t: 100 }]);
  const one = { opacity: { value: 0.8, keys: [{ t: 100, v: 0.9 }] } };
  const [last] = toggleKeyOps("c", one, ["opacity"], 100, 5, 1);
  assert.equal(last!.op, "set_clip_transform");
  assert.deepEqual((last as { transform: { opacity: unknown } }).transform.opacity, { value: 0.9 });
});

test("scale keys both axes; editing an existing key keeps its easing", () => {
  const ops = toggleKeyOps("c", {}, ["scale_x", "scale_y"], 0, 5, 1);
  assert.deepEqual(ops.map((o) => (o as { prop: string }).prop), ["scale_x", "scale_y"]);
  const tr = { rotation: { value: 0, keys: [{ t: 100, v: 5, easing: EASE_IN_OUT }] } };
  assert.deepEqual(setKeyOps("c", tr, ["rotation"], 101, 45, 5), [{ op: "set_keyframe", clip: "c", prop: "rotation", key: { t: 100, v: 45, easing: EASE_IN_OUT } }]);
  assert.deepEqual(easingOps("c", tr, ["rotation"], 100, 5, HOLD), [{ op: "set_easing", clip: "c", prop: "rotation", t: 100, easing: HOLD }]);
  assert.deepEqual(easingOps("c", tr, ["rotation"], 900, 5, HOLD), []);
});

test("an animated transform is not the identity and valuesOf reads it at the playhead", () => {
  const tr = { opacity: { value: 1, keys: [{ t: 0, v: 0 }, { t: 1000, v: 1 }] } };
  assert.ok(!isIdentity(tr));
  assert.equal(valuesOf(tr, 500).opacity, 0.5);
  assert.equal(valuesOf(tr).opacity, 1, "without a time the static value");
});

test("clipKeyTimes: absolute, unique, ascending, inside the clip only", () => {
  const clip = { start: 10_000, duration: 5000, transform: { rotation: { value: 0, keys: [{ t: 0, v: 0 }, { t: 2000, v: 1 }] }, opacity: { value: 1, keys: [{ t: 2000, v: 0 }, { t: 9000, v: 1 }] } } };
  assert.deepEqual(clipKeyTimes(clip), [10_000, 12_000]);
  assert.deepEqual(clipKeyTimes({ start: 0, duration: 10, transform: undefined }), []);
});

test("snapRotation: right angles within 3 degrees, Shift for 15 degree steps", () => {
  assert.equal(snapRotation(91.5, false), 90);
  assert.equal(snapRotation(-2, false), 0);
  assert.equal(snapRotation(184, false), 184);
  assert.equal(snapRotation(268.9, false), 270);
  assert.equal(snapRotation(100, true), 105);
  assert.equal(snapRotation(Number.NaN, false), Number.NaN);
});

test("snapMove: centre and canvas edges pull in within the tolerance, each axis on its own, nothing outside it", () => {
  const canvas = { width: 1000, height: 500 };
  // Centre 4 px right of the canvas centre: snaps back (dx -4), vertical far from anything.
  const a = snapMove({ cx: 504, cy: 100, hw: 100, hh: 50 }, canvas, 6);
  assert.deepEqual([a.dx, a.dy, a.guides], [-4, 0, { x: 0.5 }]);
  // Left edge 3 px inside the canvas edge: snaps to it (dx -3); bottom edge 2 px short of the bottom: snaps (dy +2).
  const b = snapMove({ cx: 203, cy: 448, hw: 200, hh: 50 }, canvas, 6);
  assert.deepEqual([b.dx, b.dy, b.guides], [-3, 2, { x: 0, y: 1 }]);
  // Right edge 5 px past the canvas edge.
  assert.deepEqual(snapMove({ cx: 805, cy: 100, hw: 200, hh: 20 }, canvas, 6).dx, -5);
  // Nothing within reach: no shift, no guides. The nearer of two candidates wins.
  assert.deepEqual(snapMove({ cx: 300, cy: 120, hw: 50, hh: 30 }, canvas, 6), { dx: 0, dy: 0, guides: {} });
  assert.equal(snapMove({ cx: 499, cy: 250, hw: 499.5, hh: 10 }, canvas, 6).dx, 0.5); // centre is 1 off, the left edge 0.5 off, the right edge 1.5 off: the closest wins
  // A picture as wide as the canvas: centre and both edges tie, the centre guide is the one shown.
  assert.deepEqual(snapMove({ cx: 503, cy: 250, hw: 500, hh: 250 }, canvas, 6).guides, { x: 0.5, y: 0.5 });
});

test("opacityKeyOps: a key at the playhead, removed again on a second press, nothing outside the clip (#241)", async () => {
  const { opacityKeyOps, ticksPerFrame } = await import("../../apps/web/src/inspector/keyframeModel");
  const rate = { num: 30, den: 1 };
  const tpf = ticksPerFrame(rate);
  const clip = { id: "c1", media: "m", start: 30 * tpf, duration: 60 * tpf, transform: undefined } as never;
  assert.equal(opacityKeyOps(clip, rate, 29), null, "before the clip");
  assert.equal(opacityKeyOps(clip, rate, 90), null, "after the clip");
  const add = opacityKeyOps(clip, rate, 45)!;
  assert.equal(add.length, 1);
  assert.deepEqual(add[0], { op: "set_keyframe", clip: "c1", prop: "opacity", key: { t: 15 * tpf, v: 1, easing: LINEAR } });
  const keyed = { ...(clip as object), transform: { opacity: { value: 1, keys: [{ t: 15 * tpf, v: 1, easing: LINEAR }, { t: 40 * tpf, v: 0.5, easing: LINEAR }] } } } as never;
  const off = opacityKeyOps(keyed, rate, 45)!;
  assert.deepEqual(off, [{ op: "delete_keyframe", clip: "c1", prop: "opacity", t: 15 * tpf }]);
});

test("groupKeyOps: one diamond keys position, scale and rotation together, and takes them away together", () => {
  const add = groupKeyOps("c1", undefined, TRANSFORM_GROUP, 500, 10);
  assert.equal(add.length, TRANSFORM_GROUP.length);
  assert.ok(add.every((o) => o.op === "set_keyframe"));
  // After adding: every prop has a lone key at 500 -> removing makes them static (one set_clip_transform), no deletes.
  const tr = { position_x: { value: 0, keys: [{ t: 500, v: 0 }] }, position_y: { value: 0, keys: [{ t: 500, v: 0 }] }, scale_x: { value: 1, keys: [{ t: 500, v: 1 }] }, scale_y: { value: 1, keys: [{ t: 500, v: 1 }] }, rotation: { value: 0, keys: [{ t: 500, v: 0 }] } };
  const gone = groupKeyOps("c1", tr, TRANSFORM_GROUP, 500, 10);
  assert.deepEqual(gone.map((o) => o.op), ["set_clip_transform"]);
  // Only some props keyed: the diamond completes the group.
  const part = groupKeyOps("c1", { position_x: tr.position_x }, TRANSFORM_GROUP, 500, 10);
  assert.equal(part.length, TRANSFORM_GROUP.length - 1);
  // Two keys on a prop: removing deletes just this one.
  const two = { ...tr, rotation: { value: 0, keys: [{ t: 500, v: 0 }, { t: 900, v: 5 }] } };
  assert.deepEqual(groupKeyOps("c1", two, TRANSFORM_GROUP, 500, 10).map((o) => o.op), ["set_clip_transform", "delete_keyframe"]);
});
