// M1 (menu wording): the ⋯ menu uses plain everyday words, no developer detail.
import assert from "node:assert/strict";
import { test } from "node:test";
import en from "../../apps/web/src/i18n/en.json" with { type: "json" };

const menu = en as Record<string, string>;

test("overflow menu labels are plain: no 'Engine', no 'Diagnostics', no colon-status or slash", () => {
  assert.equal(menu["menu.diagnostics"], "About OverCut");
  assert.equal(menu["menu.privacy"], "Privacy");
  assert.equal(menu["engine.menu.ready"], undefined); // UX r15 D8: the menu has no engine status at all (only "Saved on this device")
  assert.equal(menu["save.state.saved"], "Saved on this device");
  for (const key of ["menu.diagnostics", "menu.privacy", "scrub.menu.label", "save.state.saved"]) {
    assert.doesNotMatch(menu[key] ?? "", /[:/]|v\d|wasm|Diagnostics/, `${key} still has developer wording`);
  }
});

test("smooth scrubbing is a switch with a plain name, a one-line explanation and a visible On/Off state", () => {
  assert.equal(menu["scrub.menu.label"], "Smooth scrubbing");
  assert.match(menu["scrub.menu.hint"] ?? "", /space on this device/);
  assert.deepEqual([menu["scrub.menu.on"], menu["scrub.menu.off"]], ["On", "Off"]);
});
