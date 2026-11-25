import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatLabelKey } from "../../apps/web/src/export/model";

/** Audit A6: the Export dialog never says an MP4 "works in most apps" while its heads-up says it may not play, and the heads-up does not send people to WebM for "the widest support". */
const en = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../apps/web/src/i18n/en.json"), "utf8")) as Record<string, string>;

test("MP4 with AAC keeps its 'works in most apps' label; MP4 that only got Opus sound is named plainly", () => {
  assert.equal(formatLabelKey({ id: "mp4-h264", audioCodec: "aac" }), "export.format.mp4-h264");
  assert.equal(formatLabelKey({ id: "mp4-h264", audioCodec: "opus" }), "export.format.mp4-h264.opus");
  assert.equal(formatLabelKey({ id: "webm-vp9", audioCodec: "opus" }), "export.format.webm-vp9");
  assert.equal(formatLabelKey({ id: "webm-vp9", audioCodec: "opus" }, true), "export.format.webm-vp9.offline");
  assert.doesNotMatch(en[formatLabelKey({ id: "mp4-h264", audioCodec: "opus" })]!, /most apps|devices/i);
});

test("the heads-up says where the file may lose its sound and does not claim WebM plays more widely", () => {
  const warn = en["export.warn.limited"]!;
  assert.match(warn, /without sound/); // the Opus line (M2 wording): the label already says "with Opus sound", the note says who may not play it
  assert.doesNotMatch(warn, /widest|WebM/i);
});
