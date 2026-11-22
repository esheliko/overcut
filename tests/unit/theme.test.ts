import assert from "node:assert/strict";
import { test } from "node:test";
import { nextPref, parsePref, resolveTheme, THEME_PREFS } from "../../apps/web/src/theme/theme";

const q = (...on: string[]) => (query: string) => on.includes(query);

test("system preference resolves: contrast beats colour scheme; default is dark", () => {
  assert.equal(resolveTheme("system", q()), "dark");
  assert.equal(resolveTheme("system", q("(prefers-color-scheme: light)")), "light");
  assert.equal(resolveTheme("system", q("(prefers-contrast: more)")), "high-contrast");
  assert.equal(resolveTheme("system", q("(prefers-contrast: more)", "(prefers-color-scheme: light)")), "high-contrast");
});

test("an explicit choice overrides the system", () => {
  assert.equal(resolveTheme("light", q()), "light");
  assert.equal(resolveTheme("dark", q("(prefers-color-scheme: light)")), "dark");
  assert.equal(resolveTheme("high-contrast", q()), "high-contrast");
});

test("stored values are validated; the toggle cycles through every preference", () => {
  assert.equal(parsePref("light"), "light");
  assert.equal(parsePref("neon"), "system");
  assert.equal(parsePref(null), "system");
  let p = THEME_PREFS[0]!;
  const seen = new Set<string>();
  for (let i = 0; i < THEME_PREFS.length; i++) { seen.add(p); p = nextPref(p); }
  assert.equal(seen.size, THEME_PREFS.length);
  assert.equal(p, THEME_PREFS[0]);
});
