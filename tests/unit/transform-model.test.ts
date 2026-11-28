import assert from "node:assert/strict";
import { test } from "node:test";
import { isIdentity, newGestureKey, rangeOf, setField, setFields, toggleFlip, valuesOf } from "../../apps/web/src/inspector/transformModel";

test("valuesOf reads the identity from nothing and the static values from a transform", () => {
  assert.equal(valuesOf(undefined).scale_x, 1);
  assert.equal(valuesOf({ rotation: { value: 30 }, opacity: { value: 0.5 } }).rotation, 30);
  assert.ok(isIdentity(undefined) && isIdentity({}));
  assert.ok(!isIdentity({ rotation: { value: 1 } }) && !isIdentity({ flip_h: true }) && !isIdentity({ fit: "cover" }));
});

test("setField clamps to what the engine accepts and ignores non-finite input", () => {
  assert.equal(valuesOf(setField(undefined, "opacity", 3)).opacity, 1);
  assert.equal(valuesOf(setField(undefined, "scale_x", 0)).scale_x, 0.01);
  assert.deepEqual(setField({}, "rotation", Number.NaN), {});
  const t = setField({ crop_right: { value: 0.6 } }, "crop_left", 0.9);
  assert.ok(valuesOf(t).crop_left + valuesOf(t).crop_right < 1, "opposite crops always leave a picture");
  assert.deepEqual(rangeOf("opacity", valuesOf(undefined)), [0, 1]);
});

test("setFields applies a drag's x and y together; keyframes of a field are kept", () => {
  const t = setFields({ position_x: { value: 0, keys: [{ time: 0, value: 0, easing: { kind: "linear" } }] } } as never, { position_x: 0.1, position_y: -0.2 });
  assert.equal(valuesOf(t).position_x, 0.1);
  assert.equal(valuesOf(t).position_y, -0.2);
  assert.equal(t.position_x?.keys?.length, 1);
});

test("toggleFlip flips one axis; gesture keys differ and stay inside the u32 range", () => {
  assert.equal(toggleFlip({}, "h").flip_h, true);
  assert.equal(toggleFlip({ flip_h: true }, "h").flip_h, false);
  const a = newGestureKey();
  assert.notEqual(a, newGestureKey());
  assert.ok(a > 0 && a <= 0xffff_ffff);
});
