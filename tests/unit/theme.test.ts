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

import { ACCENTS, ACCENT_SWATCH, applyAccent, loadAccent, parseAccent, saveAccent } from "../../apps/web/src/theme/theme";
import { installKind, isIos } from "../../apps/web/src/install";

test("accent: unknown values fall back to teal, 7 choices, every one has a swatch", () => {
  assert.equal(parseAccent("violet"), "violet");
  assert.equal(parseAccent("hotpink"), "teal");
  assert.equal(parseAccent(null), "teal");
  assert.equal(ACCENTS.length, 7);
  for (const a of ACCENTS) assert.match(ACCENT_SWATCH[a], /^#[0-9a-f]{6}$/i);
});

test("accent: persisted locally, teal clears the key, storage failure is swallowed", () => {
  const mem = new Map<string, string>();
  const g = globalThis as { localStorage?: unknown };
  const prev = g.localStorage;
  g.localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  try {
    saveAccent("pink");
    assert.equal(mem.get("overcut.accent"), "pink");
    assert.equal(loadAccent(), "pink");
    saveAccent("teal");
    assert.equal(mem.has("overcut.accent"), false);
    assert.equal(loadAccent(), "teal");
    g.localStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    assert.equal(loadAccent(), "teal");
    assert.doesNotThrow(() => saveAccent("blue"));
  } finally { g.localStorage = prev; }
});

test("accent: applyAccent sets data-accent and announces a theme event", () => {
  const events: unknown[] = [];
  const root = { dataset: {} as Record<string, string>, dispatchEvent: (e: Event) => { events.push(e); return true; } } as unknown as HTMLElement;
  applyAccent("orange", root);
  assert.equal(root.dataset.accent, "orange");
  assert.equal(events.length, 1);
});

test("install: prompt where the browser gives one, how-to on iOS, nothing when installed or in the desktop app", () => {
  const base = { hasPrompt: false, standalone: false, ios: false, desktopApp: false };
  assert.equal(installKind(base), null);
  assert.equal(installKind({ ...base, hasPrompt: true }), "prompt");
  assert.equal(installKind({ ...base, ios: true }), "ios");
  assert.equal(installKind({ ...base, ios: true, hasPrompt: true }), "prompt");
  assert.equal(installKind({ ...base, hasPrompt: true, standalone: true }), null);
  assert.equal(installKind({ ...base, ios: true, desktopApp: true }), null);
  assert.equal(isIos("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", "iPhone", 5), true);
  assert.equal(isIos("Mozilla/5.0 (Macintosh)", "MacIntel", 5), true); // iPadOS posing as a Mac
  assert.equal(isIos("Mozilla/5.0 (Macintosh)", "MacIntel", 0), false);
  assert.equal(isIos("Mozilla/5.0 (X11; Linux x86_64)", "Linux x86_64", 0), false);
});

test("r14: a first run (nothing stored) is dark, an explicit choice including 'system' is kept", async () => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  const { loadPref, savePref } = await import("../../apps/web/src/theme/theme");
  assert.equal(loadPref(), "dark");
  savePref("system");
  assert.equal(loadPref(), "system");
  savePref("light");
  assert.equal(loadPref(), "light");
  delete (globalThis as { localStorage?: unknown }).localStorage;
});
