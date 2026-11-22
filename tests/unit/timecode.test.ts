import assert from "node:assert/strict";
import { test } from "node:test";
import { frameAt, rulerLabel, rulerStep, timecode } from "../../apps/web/src/timecode";

test("timecode is MM:SS:FF on whole frames", () => {
  assert.equal(timecode(0), "00:00:00");
  assert.equal(timecode(29), "00:00:29");
  assert.equal(timecode(30), "00:01:00");
  assert.equal(timecode(30 * 61 + 7), "01:01:07");
  assert.equal(timecode(-5), "00:00:00");
});

test("ruler labels and steps", () => {
  assert.equal(rulerLabel(65), "1:05");
  assert.equal(rulerStep(100), 1);
  assert.equal(rulerStep(40), 2);
  assert.equal(rulerStep(10), 10);
  assert.equal(rulerStep(0.1), 120);
});

test("frameAt rounds to a frame and clamps", () => {
  assert.equal(frameAt(40, 40, 1800), 30);
  assert.equal(frameAt(-10, 40, 1800), 0);
  assert.equal(frameAt(1e9, 40, 1800), 1800);
});
