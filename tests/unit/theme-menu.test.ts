// F3 (theme menu): the top-bar theme button offers System, Dark, Light and High contrast; it no longer cycles.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import en from "../../apps/web/src/i18n/en.json" with { type: "json" };
import { THEME_PREFS } from "../../apps/web/src/theme/theme";

const copy = en as Record<string, string>;
const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("the theme menu lists the four choices in order, each with a plain name", () => {
  assert.deepEqual([...THEME_PREFS], ["system", "dark", "light", "high-contrast"]);
  assert.deepEqual(THEME_PREFS.map((p) => copy[`theme.${p}`]), ["System", "Dark", "Light", "High contrast"]);
});

test("the top-bar theme button opens a menu with radio choices and a name, not a cycle", () => {
  const menu = read("apps/web/src/ThemeMenu.tsx");
  assert.match(menu, /aria-haspopup="menu"/);
  assert.match(menu, /role="menuitemradio"/);
  assert.match(menu, /aria-checked=\{p === pref\}/);
  assert.match(menu, /e\.key === "Escape"/);
  assert.doesNotMatch(read("apps/web/src/App.tsx"), /cycleTheme|nextPref/, "the theme must not cycle any more");
});
