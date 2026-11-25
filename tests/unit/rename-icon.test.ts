import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("Projects Rename uses the pencil icon, not the sliders icon", () => {
  const home = read("apps/web/src/Home.tsx");
  const rename = home.match(/data-testid="project-rename"[\s\S]*?<\/button>/)?.[0] ?? "";
  assert.match(rename, /<Icon name="pencil"/, "the Rename button's icon is named pencil");
  assert.doesNotMatch(rename, /name="edit"/);
  // the icon named pencil is a pencil drawing: a nib outline plus the stroke across the barrel
  const icons = read("apps/web/src/icons.tsx");
  assert.equal(icons.match(/^\s*pencil: "([^"]+)"/m)?.[1], "M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5ZM15 5l4 4");
  // and the sliders drawing (name "edit") stays for the Details tab
  assert.match(icons, /^\s*edit: "M4 7h9/m);
});
