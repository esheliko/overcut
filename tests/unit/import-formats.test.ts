import assert from "node:assert/strict";
import test from "node:test";
import { IMPORT_FORMATS } from "../../apps/web/src/media/formats";
import { classify } from "../../apps/web/src/media/plan";
import { stripTools } from "../../apps/web/src/layout/toolStrip";

test("every format chip on the drop zone is something the importer classifies as media (a chip is a promise)", () => {
  assert.ok(IMPORT_FORMATS.length > 0);
  assert.equal(new Set(IMPORT_FORMATS).size, IMPORT_FORMATS.length);
  for (const f of IMPORT_FORMATS) assert.notEqual(classify(`clip.${f.toLowerCase()}`, ""), null, f);
});

test("the phone's Back is an icon-only compact slot; every other tool shows its label", () => {
  const tools = stripTools({ count: 1, linked: true, overlay: true });
  assert.equal(tools.filter((t) => t.iconOnly).map((t) => t.id).join(), "back");
});
