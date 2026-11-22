import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureProject } from "../../apps/web/src/timeline/fixture";
import { clipAtTime, hitTest, trackAtY } from "../../apps/web/src/timeline/hit";
import { buildScene, firstEndingAfter, TICKS_PER_SECOND } from "../../apps/web/src/timeline/scene";
import { clampPps, decayVelocity, fitPps, GUTTER, LANE, MAX_PPS, MIN_PPS, ppsToSlider, RULER, sliderToPps, tickStep, timeToX, xToTime, zoomAt, type View } from "../../apps/web/src/timeline/view";

const scene = buildScene(fixtureProject({ tracks: 4, clipsPerTrack: 10 }));
const view = (o: Partial<View> = {}): View => ({ pps: 40, scrollX: 0, scrollY: 0, width: 800, height: 300, ...o });

test("scene flattens the project into sorted typed arrays", () => {
  assert.equal(scene.trackCount, 4);
  assert.equal(scene.clipCount, 40);
  assert.deepEqual([...scene.trackKind], [0, 1, 0, 1]);
  for (let t = 0; t < 4; t++) for (let i = scene.trackFirst[t]! + 1; i < scene.trackFirst[t + 1]!; i++) assert.ok(scene.start[i]! >= scene.end[i - 1]!);
  assert.equal(scene.start[0], 0);
  assert.ok(Math.abs(scene.end[0]! * TICKS_PER_SECOND - Math.round(scene.end[0]! * TICKS_PER_SECOND)) < 1e-3);
  assert.equal(buildScene(null).clipCount, 0);
});

test("an unsorted track is sorted instead of breaking the search", () => {
  const p = fixtureProject({ tracks: 1, clipsPerTrack: 3 });
  p.sequences[0]!.tracks[0]!.clips.reverse();
  const s = buildScene(p);
  assert.ok(s.start[0]! < s.start[1]! && s.start[1]! < s.start[2]!);
});

test("firstEndingAfter finds the first visible clip", () => {
  const lo = scene.trackFirst[0]!, hi = scene.trackFirst[1]!;
  assert.equal(firstEndingAfter(scene, lo, hi, -1), lo);
  assert.equal(firstEndingAfter(scene, lo, hi, scene.end[3]! - 0.001), lo + 3);
  assert.equal(firstEndingAfter(scene, lo, hi, 1e9), hi);
});

test("hit-testing: ruler, gutter, clip body, clip edges, gaps, empty space", () => {
  const v = view();
  const mid = (i: number) => (scene.start[i]! + scene.end[i]!) / 2;
  const x = (sec: number) => timeToX(v, sec);
  const y0 = RULER + LANE / 2;
  assert.equal(hitTest(scene, v, 300, 10).kind, "ruler");
  assert.equal(hitTest(scene, v, 10, y0).kind, "gutter");
  const h = hitTest(scene, v, x(mid(2)), y0);
  assert.deepEqual([h.kind, (h as { clip: number }).clip, (h as { edge: unknown }).edge], ["clip", 2, null]);
  assert.equal((hitTest(scene, v, x(scene.start[2]!) + 3, y0) as { edge: unknown }).edge, "start");
  assert.equal((hitTest(scene, v, x(scene.end[2]!) - 3, y0) as { edge: unknown }).edge, "end");
  const gap = (scene.end[2]! + scene.start[3]!) / 2;
  assert.equal(hitTest(scene, v, x(gap), y0).kind, "track");
  assert.equal(hitTest(scene, v, x(mid(scene.trackFirst[1]!)), y0 + LANE).kind, "clip");
  assert.equal((hitTest(scene, v, x(mid(0)), y0 + LANE) as { track: number }).track, 1);
  assert.equal(hitTest(scene, v, 300, RULER + 4 * LANE + 5).kind, "empty");
});

test("hit-testing follows scroll", () => {
  const v = view({ scrollX: 400, scrollY: LANE });
  assert.equal(trackAtY(scene, v, RULER + 5), 1);
  const i = scene.trackFirst[1]!;
  const sec = (scene.start[i]! + scene.end[i]!) / 2;
  assert.equal(clipAtTime(scene, 1, sec), i);
  assert.equal(clipAtTime(scene, 1, -5), -1);
  assert.equal(trackAtY(scene, v, 5), -1);
});

test("zoomAt keeps the time under the anchor fixed and clamps", () => {
  const v = view({ scrollX: 120 });
  const before = xToTime(v, 400);
  zoomAt(v, 160, 400);
  assert.equal(v.pps, 160);
  assert.ok(Math.abs(xToTime(v, 400) - before) < 1e-9);
  zoomAt(v, 1e9, 400);
  assert.equal(v.pps, MAX_PPS);
  zoomAt(v, 0, 400);
  assert.equal(v.pps, MIN_PPS);
  assert.ok(v.scrollX >= 0);
});

test("zoom slider is logarithmic and invertible", () => {
  assert.equal(ppsToSlider(MIN_PPS), 0);
  assert.equal(ppsToSlider(MAX_PPS), 1);
  for (const p of [3, 40, 240, 900]) assert.ok(Math.abs(sliderToPps(ppsToSlider(p)) - p) < 1e-6);
  assert.equal(clampPps(-1), MIN_PPS);
  assert.ok(fitPps(view(), 60) < 15 && fitPps(view(), 60) > 10);
});

test("ruler step adapts to zoom and fling decays", () => {
  assert.equal(tickStep(40), 2);
  assert.equal(tickStep(500), 0.2);
  assert.equal(tickStep(2), 60);
  assert.ok(decayVelocity(1, 325) < 0.37 && decayVelocity(1, 325) > 0.36);
  assert.equal(decayVelocity(0, 16), 0);
  assert.equal(GUTTER, 48);
});
