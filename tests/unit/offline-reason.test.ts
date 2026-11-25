import test from "node:test";
import assert from "node:assert/strict";
import { offlineReason } from "../../apps/web/src/media/plan";

test("an input-picked file (no handle) says the browser did not keep it; a handle or path says it moved", () => {
  assert.equal(offlineReason("file:clip.mp4:1234"), "reopen");
  assert.equal(offlineReason("fs:m1"), "moved");
  assert.equal(offlineReason("path:/home/a/clip.mp4"), "moved");
  assert.equal(offlineReason(undefined), "moved");
});
