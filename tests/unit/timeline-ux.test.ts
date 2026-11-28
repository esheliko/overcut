import assert from "node:assert/strict";
import { test } from "node:test";
import { clipMenuItems } from "../../apps/web/src/timeline/clipMenu";
import { mediaToAdd } from "../../apps/web/src/timeline/addMedia";
import { pointerDown, pointerMove, TOUCH_SLOP, SLOP, type Ctx, type PEvent } from "../../apps/web/src/timeline/interact";
import { buildScene } from "../../apps/web/src/timeline/scene";
import { sampleProject } from "../../apps/web/src/timeline/fixture";
import { formatDur, GUTTER_WIDE, LANE, RULER, shouldAutoFit, WHEEL_NOTCH, wheelZoomFactor, type View } from "../../apps/web/src/timeline/view";
import { flagsOf, indicesOf } from "../../apps/web/src/timeline/edit";
import { zoomStore } from "../../apps/web/src/timeline/zoomStore";
import type { Project } from "@app/engine-client";

test("ctrl + wheel: one notch zooms by about 1.28x, a hard fling never more (T-04)", () => {
  assert.ok(Math.abs(wheelZoomFactor(-100, false) - WHEEL_NOTCH) < 1e-9, "a 100 px notch is the clamp");
  assert.ok(Math.abs(wheelZoomFactor(100, false) - 1 / WHEEL_NOTCH) < 1e-9);
  assert.equal(wheelZoomFactor(-4000, false), WHEEL_NOTCH, "a fling is clamped");
  assert.equal(wheelZoomFactor(4000, true), 1 / WHEEL_NOTCH);
  const small = wheelZoomFactor(-3, true); // a trackpad pinch sends small deltas: fine control stays
  assert.ok(small > 1 && small < 1.05);
  assert.equal(wheelZoomFactor(0, false), 1);
});

test("auto-fit after an import: first clip always, later only past the viewport and never over a hand-set zoom (L-06)", () => {
  const base = { prevClips: 0, clips: 1, prevEndSec: 0, endSec: 3, visibleEndSec: 30, userZoomed: false };
  assert.equal(shouldAutoFit(base), true, "the first clip fits the width");
  assert.equal(shouldAutoFit({ ...base, userZoomed: true }), true, "...even if the zoom was touched on the empty timeline");
  const more = { prevClips: 2, clips: 3, prevEndSec: 10, endSec: 18, visibleEndSec: 6, userZoomed: false };
  assert.equal(shouldAutoFit(more), true, "an import that runs past the right edge");
  assert.equal(shouldAutoFit({ ...more, visibleEndSec: 60 }), false, "still fits the viewport: leave the zoom");
  assert.equal(shouldAutoFit({ ...more, userZoomed: true }), false, "the person zoomed by hand");
  assert.equal(shouldAutoFit({ ...more, clips: 2 }), false, "no new clip (an edit, a trim)");
  assert.equal(shouldAutoFit({ ...more, endSec: 10 }), false, "the end did not move (a clip added in the middle)");
});

test("zoom store: a hand-made zoom is remembered, Fit hands control back, an automatic fit keeps the flag", () => {
  zoomStore.reset(40);
  let seen = 0;
  const off = zoomStore.subscribe(() => { seen++; });
  assert.equal(zoomStore.userZoomed(), false);
  zoomStore.set(80, "user");
  assert.equal(zoomStore.get(), 80);
  assert.equal(zoomStore.userZoomed(), true);
  zoomStore.set(20, "auto");
  assert.equal(zoomStore.userZoomed(), true, "an automatic fit does not clear it");
  zoomStore.set(30, "fit");
  assert.equal(zoomStore.userZoomed(), false);
  zoomStore.set(30, "fit");
  assert.equal(seen, 3, "an unchanged value notifies nobody");
  zoomStore.set(1e9, "user");
  assert.ok(zoomStore.get() < 1e9, "clamped to the zoom range");
  off();
  zoomStore.reset(40);
});

test("lengths on the drag ghost read short", () => {
  assert.equal(formatDur(4), "4s");
  assert.equal(formatDur(4.25), "4.3s");
  assert.equal(formatDur(12.4), "12s");
  assert.equal(formatDur(65), "1:05");
  assert.equal(formatDur(119.7), "2:00");
  assert.equal(formatDur(-1), "0s");
});

test("clip context menu: rows and why a row is unavailable (T-03)", () => {
  const ids = (s: Parameters<typeof clipMenuItems>[0]) => clipMenuItems(s).map((i) => `${i.id}${i.disabled ? "!" : ""}`);
  const one = { clips: 1, anyLinked: false, allLocked: false, still: false, sound: true, muted: false };
  assert.deepEqual(ids(one), ["split", "duplicate", "delete", "rippleDelete", "unlink!", "mute", "speed:0.5", "speed:1", "speed:1.5", "speed:2"]);
  assert.equal(clipMenuItems(one).find((i) => i.id === "unlink")!.why, "linked");
  assert.deepEqual(ids({ ...one, anyLinked: true }).filter((x) => x.startsWith("unlink")), ["unlink"]);
  const many = ids({ ...one, clips: 3 });
  assert.ok(many.includes("delete") && many.includes("speed:2!"), "speed needs exactly one clip");
  assert.equal(clipMenuItems({ ...one, clips: 3 }).find((i) => i.id === "speed:2")!.why, "one");
  assert.equal(clipMenuItems({ ...one, still: true }).find((i) => i.id === "speed:2")!.why, "still");
  assert.ok(ids({ ...one, allLocked: true }).every((x) => x.endsWith("!") || x === "unlink!"), "a locked track: nothing can run");
  assert.equal(clipMenuItems({ ...one, clips: 0 }).find((i) => i.id === "split")!.why, "select");
  // Mute clip (r16): offered for a sound, says why when the clip has none
  assert.equal(clipMenuItems(one).find((i) => i.id === "mute")!.disabled, false);
  assert.equal(clipMenuItems({ ...one, sound: false }).find((i) => i.id === "mute")!.why, "silent");
});

test("add media at playhead: the selected clip's media wins, else the newest ready card, else nothing (T-01)", () => {
  const project = {
    media: [], sequences: [{ tracks: [{ id: "t", kind: "video", clips: [{ id: "c1", media: "m1" }, { id: "c2", media: "m2" }] }] }],
  } as unknown as Project;
  const cards = [{ id: "m3", status: "probing" }, { id: "m2", status: "ready" }, { id: "m1", status: "ready" }];
  assert.equal(mediaToAdd(project, new Set(["c1"]), cards), "m1");
  assert.equal(mediaToAdd(project, new Set(), cards), "m2", "newest ready card");
  assert.equal(mediaToAdd(project, new Set(["c9"]), cards), "m2");
  assert.equal(mediaToAdd(null, new Set(), [{ id: "m3", status: "probing" }]), null);
  assert.equal(mediaToAdd(project, new Set(["c1"]), [{ id: "m1", status: "offline" }]), null, "offline media cannot be added");
});

test("touch: a press must travel 8 px before it becomes a drag; a mouse needs 6", () => {
  const scene = buildScene(sampleProject());
  const view: View = { pps: 40, scrollX: 0, scrollY: 0, width: 900, height: 400, gutter: GUTTER_WIDE };
  const sel = new Set<string>();
  const c: Ctx = { scene, view, selected: sel, selFlags: flagsOf(scene, indicesOf(scene, sel)) };
  const x = GUTTER_WIDE + 200, y = RULER + LANE / 2 + 0.5 * LANE * 0; // lane 0
  const ev = (px: number, kind: PEvent["kind"]): PEvent => ({ x: px, y, kind, shift: false, additive: false });
  for (const [kind, slop] of [["touch", TOUCH_SLOP], ["mouse", SLOP]] as const) {
    const down = pointerDown(c, ev(x, kind));
    assert.equal(down.g.k, "press", `${kind}: pressing on a clip or empty space starts as a press`);
    assert.equal(pointerMove(c, down.g, ev(x + slop, kind)).g.k, "press", `${kind}: ${slop} px is still a tap`);
    assert.notEqual(pointerMove(c, down.g, ev(x + slop + 1, kind)).g.k, "press", `${kind}: past ${slop} px it is a drag`);
  }
});
