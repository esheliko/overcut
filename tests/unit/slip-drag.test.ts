import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureProject } from "../../apps/web/src/timeline/fixture";
import { flagsOf } from "../../apps/web/src/timeline/edit";
import { pointerDown, pointerMove, pointerUp, type Ctx, type PEvent } from "../../apps/web/src/timeline/interact";
import { buildScene, TICKS_PER_SECOND } from "../../apps/web/src/timeline/scene";
import { LANE, RULER, timeToX, type View } from "../../apps/web/src/timeline/view";

// One track, two clips; the first is the left half of a split (footage after its end, none before), the second the right half (footage before, none after).
const project = fixtureProject({ tracks: 1, clipsPerTrack: 2, clipSec: 4 });
const [a, b] = project.sequences[0]!.tracks[0]!.clips;
project.media[0]!.duration = 8 * TICKS_PER_SECOND;
a!.source_in = 0;
b!.source_in = 4 * TICKS_PER_SECOND;
const scene = buildScene(project);
const view: View = { pps: 40, scrollX: 0, scrollY: 0, width: 900, height: 400 };
const ctx: Ctx = { scene, view, selected: new Set(), selFlags: flagsOf(scene, []) };
const alt = (x: number): PEvent => ({ x, y: RULER + LANE / 2, kind: "mouse", shift: false, additive: false, alt: true });
const mid = (i: number) => timeToX(view, (scene.start[i]! + scene.end[i]!) / 2);

function slip(i: number, dx: number) {
  const down = pointerDown(ctx, alt(mid(i)));
  assert.equal(down.g.k, "tool");
  const moved = pointerMove(ctx, down.g, alt(mid(i) + dx));
  return pointerUp(ctx, moved.g, alt(mid(i) + dx));
}

test("slip the left half of a split: dragging left works, dragging right (no footage that way) says so instead of doing nothing", () => {
  const ok = slip(0, -40);
  assert.equal(ok.fx.ops?.length, 1);
  const none = slip(0, 40);
  assert.equal(none.fx.ops, undefined);
  assert.equal(none.fx.say?.key, "timeline.say.slipOtherWay");
  assert.equal(none.fx.visible, true);
});

test("slip the right half of a split: dragging right works, dragging left says so", () => {
  assert.equal(slip(1, 40).fx.ops?.length, 1);
  assert.equal(slip(1, -40).fx.say?.key, "timeline.say.slipOtherWay");
});

test("a click without a drag stays silent", () => {
  assert.equal(slip(0, 2).fx.say, undefined);
});
