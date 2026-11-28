import test from "node:test";
import assert from "node:assert/strict";
import type { Project } from "@app/engine-client";
import { detailsKind, pickedClips, selectionCount, selectionText, tabFor, tabLabelKey, tabsOf } from "../../apps/web/src/inspector/detailsModel";
import { secondsText, stillOps, stillTicks } from "../../apps/web/src/inspector/durationModel";
import { etaSeconds, formatGapSeconds, newEta, stepEta } from "../../apps/web/src/export/model";

const clip = (id: string, media: string, link?: string) => ({ id, media, start: 705_600_000, source_in: 0, duration: 705_600_000, speed: { num: 1, den: 1 }, link: link ?? null });
const project = {
  media: [{ id: "v", kind: "video" }, { id: "i", kind: "image" }, { id: "m", kind: "audio" }],
  sequences: [{ frame_rate: { num: 30, den: 1 }, tracks: [
    { kind: "video", clips: [clip("a", "v", "L"), clip("p", "i"), clip("c", "v", "M")] },
    { kind: "audio", clips: [clip("b", "v", "L"), clip("m1", "m"), clip("m2", "m"), clip("d", "v", "M")] },
  ] }],
} as unknown as Project;
const kindOf = (...ids: string[]) => detailsKind(pickedClips(project, new Set(ids)));

test("Details kind: a picture (with or without its linked sound), a photo, a sound, several", () => {
  assert.equal(kindOf(), "none");
  assert.equal(kindOf("a"), "video");
  assert.equal(kindOf("a", "b"), "video"); // the pair is one clip
  assert.equal(kindOf("p"), "photo");
  assert.equal(kindOf("m1"), "audio");
  assert.equal(kindOf("m1", "m2"), "audios");
  assert.equal(kindOf("a", "p"), "multi");
  assert.equal(kindOf("a", "m1"), "video"); // one picture plus a loose sound: Details shows the picture, as before
});

test("tabs per kind: audio has Audio (no Video), a photo has Duration (no Speed), and the default is the kind's first tab", () => {
  assert.deepEqual(tabsOf("video"), ["video", "speed"]);
  assert.deepEqual(tabsOf("audio"), ["audio", "speed"]);
  assert.deepEqual(tabsOf("photo"), ["video", "duration"]);
  assert.ok(!tabsOf("audio").includes("video"));
  assert.ok(!tabsOf("photo").includes("speed"));
  // a Speed tab left by the last selection does not carry over to a sound's kind... it exists there, but the default is Audio
  assert.equal(tabFor("audio", null), "audio");
  assert.equal(tabFor("audio", "video"), "audio"); // a request for a tab this kind lacks
  assert.equal(tabFor("photo", "speed"), "video");
  assert.equal(tabFor("video", "speed"), "speed");
  assert.equal(tabLabelKey("photo", "video"), "details.tab.photo");
  assert.equal(tabLabelKey("video", "video"), "details.tab.video");
  assert.equal(tabLabelKey("audio", "audio"), "details.tab.audio");
});

test("one selection formatter: a linked picture and sound are one clip, in the chip and in Details", () => {
  const t = (k: string, v?: Record<string, string | number>) => `${k}:${v?.count}`;
  const two = selectionCount(pickedClips(project, new Set(["a", "b", "c", "d"]))); // two linked pairs
  assert.deepEqual(two, { clips: 2, withLinked: true });
  assert.equal(selectionText(t, two), "timeline.selected.linked:2");
  const plain = selectionCount(pickedClips(project, new Set(["p", "m1"])));
  assert.deepEqual(plain, { clips: 2, withLinked: false });
  assert.equal(selectionText(t, plain), "timeline.selected:2");
});

test("photo length: whole frames, 0.1 to 3600 s, one trim_out", () => {
  const rate = { num: 30, den: 1 };
  assert.equal(stillTicks(1, rate), 705_600_000);
  assert.equal(stillTicks(0.5, rate), 352_800_000);
  assert.equal(stillTicks(0.05, rate), null);
  assert.equal(stillTicks(3601, rate), null);
  assert.equal(stillTicks(NaN, rate), null);
  assert.deepEqual(stillOps({ id: "p", start: 705_600_000 }, 1_411_200_000), [{ op: "trim_out", clip: "p", end: 2_116_800_000 }]);
  assert.equal(secondsText(2_116_800_000), "3");
  assert.equal(secondsText(1_764_000_000), "2.5");
});

test("the time left only counts down, however the rate wobbles", () => {
  const s = newEta();
  let now = 0;
  let f = 0;
  const seen: number[] = [];
  const speeds = [0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.002, 0.002, 0.002, 0.002, 0.02, 0.02, 0.002, 0.002]; // fraction per second: a stall, then a burst
  for (const sp of speeds) {
    for (let i = 0; i < 2; i++) { now += 500; f += sp / 2; const v = stepEta(s, now, f); if (v !== null) seen.push(v * 1000); }
  }
  assert.ok(seen.length > 0);
  // the shown figure is derived from a deadline that can only move earlier; whole seconds left never climb while time passes
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i]! <= seen[i - 1]! + 1000, `${seen[i - 1]} -> ${seen[i]}`);
  assert.equal(stepEta(newEta(), 100, 0), null); // no rate yet
  assert.equal(etaSeconds(400), 1);
});

test("gap seconds read plainly", () => {
  assert.equal(formatGapSeconds(18), "18");
  assert.equal(formatGapSeconds(18.4), "18");
  assert.equal(formatGapSeconds(2.54), "2.5");
  assert.equal(formatGapSeconds(0.02), "0.1");
});
