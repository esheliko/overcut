// F4 (accent grid): every swatch has a plain name (aria-label and tooltip), and the swatches sit in a 4-column grid.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import en from "../../apps/web/src/i18n/en.json" with { type: "json" };
import { ACCENTS } from "../../apps/web/src/theme/theme";

const copy = en as Record<string, string>;
const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("every accent swatch has a plain name for screen readers and a tooltip", () => {
  const src = read("apps/web/src/AppearanceInstall.tsx");
  assert.match(src, /aria-label=\{t\(`accent\.\$\{a\}`\)\}/);
  assert.match(src, /title=\{t\(`accent\.\$\{a\}`\)\}/);
  for (const a of ACCENTS) assert.ok(copy[`accent.${a}`], `missing name for ${a}`);
});

test("the accent swatches use a 4-column grid, not a wrap", () => {
  assert.match(read("apps/web/src/styles.css"), /\.menu-accent-row \{ display: grid; grid-template-columns: repeat\(4, 44px\);/);
});
