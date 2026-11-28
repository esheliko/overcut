import assert from "node:assert/strict";
import test from "node:test";
import { clampPicture, MIN_PHONE_TIMELINE, MIN_PREVIEW_SHARE } from "../../apps/web/src/layout/split";

// UX r15 D7: the phone preview/timeline grab bar keeps the whole preview >= 30 % of the workspace and the timeline >= 260 px.
const room = 700, other = 120, chrome = 90; // workspace, top rows + tool strip, player bar and padding

test("phone preview: never smaller than 30 % (picture + its bar) and never so big that the timeline drops under 260 px", () => {
  const min = clampPicture(0, room, other, chrome), max = clampPicture(Infinity, room, other, chrome);
  assert.equal(min + chrome, Math.round(room * MIN_PREVIEW_SHARE));
  assert.equal(room - other - (max + chrome), MIN_PHONE_TIMELINE);
  assert.equal(clampPicture(200, room, other, chrome), 200); // inside the range: unchanged
});

test("phone preview: a tiny workspace still gives a usable (>= 72 px) picture and min never exceeds max", () => {
  const min = clampPicture(0, 400, other, chrome), max = clampPicture(Infinity, 400, other, chrome);
  assert.ok(min <= max);
  assert.ok(min >= 72);
});
