// F1 (saved state): the top bar says what autosave is doing, in plain words, and never claims a save it has not made.
import assert from "node:assert/strict";
import { test } from "node:test";
import en from "../../apps/web/src/i18n/en.json" with { type: "json" };

const copy = en as Record<string, string>;

test("the top bar save state has a plain, text label for every state (not colour alone)", () => {
  assert.equal(copy["save.state.saved"], "Saved on this device");
  assert.equal(copy["save.state.saving"], "Saving…");
  assert.equal(copy["save.state.error"], "Not saving on this device");
  assert.equal(copy["save.state.opening"], "Opening…");
});

test("Save project as... stays in the menu", () => {
  assert.equal(copy["menu.saveProject"], "Save project as…");
});
