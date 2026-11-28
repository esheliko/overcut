import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureProject } from "../../apps/web/src/timeline/fixture";
import { gapSummary, pictureGaps } from "../../apps/web/src/timeline/gaps";
import { buildScene, TICKS_PER_SECOND } from "../../apps/web/src/timeline/scene";

test("butted clips have no gap; a trimmed clip leaves one the export would show as black (UX r15)", () => {
  const p = fixtureProject({ tracks: 1, clipsPerTrack: 2, clipSec: 4 });
  const c = p.sequences[0]!.tracks[0]!.clips;
  c[1]!.start = c[0]!.start + c[0]!.duration;
  assert.deepEqual(gapSummary(buildScene(p)), { count: 0, seconds: 0 });
  c[1]!.start += 2 * TICKS_PER_SECOND; // a 2 s hole between them
  const s = buildScene(p);
  const g = pictureGaps(s);
  assert.equal(g.length, 1);
  assert.ok(Math.abs(gapSummary(s).seconds - 2) < 0.01);
});

test("a project with no clips has no gaps", () => {
  assert.deepEqual(gapSummary(buildScene(null)), { count: 0, seconds: 0 });
});
