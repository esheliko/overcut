import assert from "node:assert/strict";
import { test } from "node:test";
import { EASE_IN_OUT, LINEAR, HOLD, clipKeyTimes, easingId, easingOps, evalAnimated, keyState, neighbourKey, setKeyOps, toggleKeyOps } from "../../apps/web/src/inspector/keyframeModel";
import { isIdentity, snapRotation, valuesOf } from "../../apps/web/src/inspector/transformModel";

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
