import test from "node:test";
import assert from "node:assert/strict";
import { clipDetail, fitPps, formatTick, MAX_PPS, MIN_PPS, minorDivisions, tickStep, viewForRange, type View } from "../../apps/web/src/timeline/view";
import { fitsView, MIN_WINDOW, overviewSpan, panTo, partAt, resizeTo, windowOf } from "../../apps/web/src/timeline/overview";

const view = (over: Partial<View> = {}): View => ({ pps: 10, scrollX: 0, scrollY: 0, width: 1200, height: 400, gutter: 148, ...over });

test("zoom range covers a 10 s clip and a 10 h project across the width", () => {
  const v = view();
  assert.ok(fitPps(v, 10) <= MAX_PPS && fitPps(v, 10) > 50, "10 s fills the width");
  const p10h = fitPps(v, 36000);
  assert.ok(p10h >= MIN_PPS, "10 h is reachable");
  assert.ok(36000 * p10h <= v.width - 148, "10 h fits the width");
  const phone = view({ width: 320, gutter: 60 });
  assert.ok(fitPps(phone, 36000) >= MIN_PPS, "10 h fits at 320 px too");
});

test("ruler labels never overlap: the step times the zoom is at least the minimum gap, at every scale", () => {
  for (let pps = MIN_PPS; pps <= MAX_PPS; pps *= 1.07) {
    const step = tickStep(pps);
    assert.ok(step * pps >= 72 - 1e-9 || step === 43200, `pps ${pps}: step ${step}`);
    const minor = step / minorDivisions(step);
    assert.ok(minor > 0 && Math.abs(step / minor - Math.round(step / minor)) < 1e-9, "minor divides the step");
  }
});

test("tick labels switch to h:mm at long scales", () => {
  assert.equal(formatTick(75, 5), "1:15");
  assert.equal(formatTick(75.5, 0.5), "1:15.5");
  assert.equal(formatTick(3600, 60), "1:00");
  assert.equal(formatTick(5400, 600), "1:30");
  assert.equal(formatTick(3725, 5), "1:02:05");
  assert.equal(formatTick(36000, 3600), "10:00");
  assert.equal(formatTick(1800, 600), "30:00");
});

test("clips drop to a plain block, then tiles, then tiles with a name as they widen", () => {
  assert.equal(clipDetail(3), "block");
  assert.equal(clipDetail(30), "tiles");
  assert.equal(clipDetail(80), "name");
});

test("viewForRange fits the range inside the width with a margin", () => {
  const v = view();
  const r = viewForRange(v, 100, 200)!;
  assert.ok(Math.abs((200 - 100) * r.pps - (v.width - 148 - 48)) < 1e-6);
  assert.ok(Math.abs(r.scrollX - (100 * r.pps - 24)) < 1e-6);
  assert.equal(viewForRange(v, 5, 5), null);
});

test("overview: hidden when the project fits, window follows scroll and zoom", () => {
  assert.equal(fitsView(view({ pps: 10 }), 60), true);
  assert.equal(fitsView(view({ pps: 10 }), 600), false);
  const v = view({ pps: 10, scrollX: 3000 }); // 2 h project
  const len = 7200, bar = 1000;
  const w = windowOf(v, len, bar);
  const span = overviewSpan(v, len);
  assert.ok(Math.abs(w.x0 - (300 / span) * bar) < 1e-6);
  assert.ok(Math.abs(w.x1 - w.x0 - (105 / span) * bar) < MIN_WINDOW, "window width is the visible seconds, floored at MIN_WINDOW");
  assert.ok(w.x1 - w.x0 >= MIN_WINDOW);
});

test("overview: dragging the window pans, edges zoom, outside jumps", () => {
  const v = view({ pps: 1, scrollX: 0 });
  const len = 3600, bar = 800;
  const w = windowOf(v, len, bar);
  assert.equal(partAt(w, w.x0 + 1), "left");
  assert.equal(partAt(w, w.x1 - 1), "right");
  assert.equal(partAt(w, (w.x0 + w.x1) / 2), "body");
  assert.equal(partAt(w, w.x1 + 100), "outside");
  // Pan: moving the pointer by 100 bar px moves the scroll by 100/bar of the span.
  const grab = 5;
  const a = panTo(v, len, bar, w.x0 + grab, grab), b = panTo(v, len, bar, w.x0 + grab + 100, grab);
  assert.ok(Math.abs(b - a - (100 / bar) * overviewSpan(v, len) * v.pps) < 1e-6);
  assert.equal(panTo(v, len, bar, -50, 0), 0, "never negative");
  // Resize the right edge to double the window: the zoom halves and the left edge stays.
  const wide = resizeTo(v, len, bar, w, "right", w.x0 + (w.x1 - w.x0) * 2);
  assert.ok(Math.abs(wide.pps - v.pps / 2) < 1e-6 && wide.scrollX === 0);
  // Left edge: the right edge's time stays put.
  const v2 = view({ pps: 1, scrollX: 400 });
  const w2 = windowOf(v2, len, bar);
  const narrow = resizeTo(v2, len, bar, w2, "left", w2.x0 + (w2.x1 - w2.x0) / 2);
  const rightBefore = (v2.scrollX + (v2.width - 148)) / v2.pps, rightAfter = (narrow.scrollX + (v2.width - 148)) / narrow.pps;
  assert.ok(Math.abs(rightBefore - rightAfter) < 1e-6);
  assert.ok(narrow.pps > v2.pps);
});
