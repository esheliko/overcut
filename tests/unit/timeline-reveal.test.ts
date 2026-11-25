import assert from "node:assert/strict";
import { test } from "node:test";
import { GUTTER, revealTime, timeToX, zoomKeeping, type View } from "../../apps/web/src/timeline/view";

const view = (over: Partial<View> = {}): View => ({ pps: 40, scrollX: 0, scrollY: 0, width: 300, height: 150, ...over });
const onScreen = (v: View, sec: number) => { const x = timeToX(v, sec); return x >= GUTTER && x <= v.width; };

test("import on a 320 px phone: the playhead at 0:00 stays on screen after the fit zoom", () => {
  // The bug: the view was scrolled to ~0:03 while the playhead stayed at 0:00 (off screen to the left).
  const v = view({ width: 304, scrollX: 120 });
  const pps = (v.width - GUTTER - 96) / 6; // fit a 6 s project
  zoomKeeping(v, pps, 0);
  assert.ok(onScreen(v, 0), `playhead at x=${timeToX(v, 0)} is off screen`);
  assert.equal(v.scrollX, 0);
});

test("zoom with the playhead visible keeps it under the same pixel", () => {
  const v = view({ scrollX: 10 });
  const before = timeToX(v, 2);
  zoomKeeping(v, 80, 2);
  assert.ok(Math.abs(timeToX(v, 2) - before) < 1e-9);
});

test("revealTime scrolls left and right only when the playhead is off screen", () => {
  const left = view({ scrollX: 200 });
  revealTime(left, 1);
  assert.ok(onScreen(left, 1));
  const right = view({ scrollX: 0 });
  revealTime(right, 20);
  assert.ok(onScreen(right, 20));
  const inside = view({ scrollX: 50 });
  revealTime(inside, 3);
  assert.equal(inside.scrollX, 50); // already visible: no jump
});
