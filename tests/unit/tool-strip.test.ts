import assert from "node:assert/strict";
import test from "node:test";
import { stripTools } from "../../apps/web/src/layout/toolStrip";
import { detentHeights } from "../../apps/web/src/layout/sheet";

const ids = (o: { count: number; linked: boolean; overlay: boolean }) => stripTools(o).map((t) => t.id);

test("nothing selected: the global tools, Media and Edit always there", () => {
  assert.deepEqual(ids({ count: 0, linked: false, overlay: true }), ["media", "overlay", "split", "canvas", "edit"]);
  assert.ok(!ids({ count: 0, linked: false, overlay: false }).includes("overlay"));
});

test("a clip selected: back first, then the clip's tools; Detach only for a linked clip", () => {
  const alone = ids({ count: 1, linked: false, overlay: true });
  assert.equal(alone[0], "back");
  for (const id of ["edit", "split", "speed", "crop", "duplicate", "delete", "keyframe"]) assert.ok(alone.includes(id as never), id);
  assert.ok(!alone.includes("detach" as never));
  assert.ok(ids({ count: 1, linked: true, overlay: true }).includes("detach"));
});

test("every strip tool has a label key and an icon name", () => {
  for (const t of [...stripTools({ count: 0, linked: false, overlay: true }), ...stripTools({ count: 2, linked: true, overlay: true })]) { assert.ok(t.label); assert.ok(t.icon); }
});

test("the Edit sheet opens at about 45 % and each detent is taller than the one before", () => {
  for (const vh of [568, 667, 844, 932]) {
    const h = detentHeights(vh);
    assert.ok(h.peek < h.half && h.half < h.full, String(vh));
    assert.ok(h.peek / vh >= 0.35 && h.peek / vh <= 0.5, `${vh}: ${h.peek}`);
  }
});
