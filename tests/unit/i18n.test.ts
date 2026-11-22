import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import en from "../../apps/web/src/i18n/en.json" with { type: "json" };
import { createTranslator, directionOf, negotiateLocale, pseudoLocalize } from "../../apps/web/src/i18n/core";

const tr = createTranslator("en", en);

test("ICU plural: English one/other", () => {
  assert.equal(tr.t("timeline.playheadText", { seconds: 1 }), "1 second");
  assert.equal(tr.t("timeline.playheadText", { seconds: 0 }), "0 seconds");
  assert.equal(tr.t("timeline.playheadText", { seconds: 2.5 }), "2.5 seconds");
});

test("ICU plural: other languages use their own rules (Polish few/many, Arabic zero/two)", () => {
  const msg = "{n, plural, zero {zero} one {one} two {two} few {few} many {many} other {other}}";
  const pl = createTranslator("pl", { m: msg });
  assert.deepEqual([1, 2, 5, 22, 1.5].map((n) => pl.t("m", { n })), ["one", "few", "many", "few", "other"]);
  const ar = createTranslator("ar", { m: msg });
  assert.deepEqual([0, 1, 2, 3, 11, 100].map((n) => ar.t("m", { n })), ["zero", "one", "two", "few", "many", "other"]);
});

test("arguments are substituted; a missing key returns the key; a broken message does not throw", () => {
  assert.equal(tr.t("engine.ready", { name: "app", version: "0.1.0", backend: "wasm" }), "Engine app v0.1.0 (wasm)");
  assert.equal(tr.t("no.such.key"), "no.such.key");
  assert.equal(createTranslator("en", { bad: "{unclosed" }).t("bad"), "{unclosed");
});

test("a locale missing a key falls back to English", () => {
  const fr = createTranslator("fr", { "player.play": "Lecture" }, en);
  assert.equal(fr.t("player.play"), "Lecture");
  assert.equal(fr.t("player.pause"), "Pause");
});

test("locale negotiation: exact, truncation, regional variant, fallback", () => {
  const have = ["en", "de", "pt-BR", "zh-Hant"];
  assert.equal(negotiateLocale(["de-AT", "en"], have), "de");
  assert.equal(negotiateLocale(["pt"], have), "pt-BR");
  assert.equal(negotiateLocale(["zh-Hant-TW"], have), "zh-Hant");
  assert.equal(negotiateLocale(["PT-br"], have), "pt-BR");
  assert.equal(negotiateLocale(["ja", "fr"], have), "en");
  assert.equal(negotiateLocale([], have), "en");
  assert.equal(negotiateLocale(["fr", "de"], have), "de");
});

test("direction: Arabic, Hebrew, Persian, Urdu are RTL; others LTR", () => {
  for (const l of ["ar", "ar-EG", "he", "fa", "ur", "ps"]) assert.equal(directionOf(l), "rtl", l);
  for (const l of ["en", "de", "ja", "zh-Hant", "pt-BR", "ru"]) assert.equal(directionOf(l), "ltr", l);
  assert.equal(directionOf("en-XB"), "rtl"); // pseudo-bidi test locale
  assert.equal(directionOf("not a locale!"), "ltr");
});

test("pseudo-locales keep ICU syntax valid and plurals working", () => {
  const xa = createTranslator("en-XA", pseudoLocalize(en, "accent"));
  assert.equal(xa.t("timeline.playheadText", { seconds: 1 }).includes("1"), true);
  assert.notEqual(xa.t("player.play"), "Play");
  assert.match(xa.t("engine.ready", { name: "app", version: "1", backend: "wasm" }), /app.*1.*wasm/);
  const xb = pseudoLocalize(en, "bidi");
  assert.ok(xb["player.play"]!.startsWith("‮"));
  for (const k of Object.keys(en)) assert.doesNotThrow(() => createTranslator("en", xb).t(k, { name: "a", version: "1", backend: "b", message: "m", seconds: 2, milestone: "M1", tool: "x", theme: "y" }), k);
});

test("every message in the catalog parses", () => {
  for (const [k, v] of Object.entries(en)) {
    const out = createTranslator("en", { [k]: v }).t(k, { name: "a", version: "1", backend: "b", message: "m", seconds: 2, milestone: "M1", tool: "x", theme: "y" });
    assert.ok(out.length > 0, k);
  }
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
}

test("every t(\"key\") used in the web app exists in the English catalog", () => {
  const root = new URL("../../apps/web/src", import.meta.url).pathname;
  const used = new Set<string>();
  for (const f of walk(root).filter((p) => /\.tsx?$/.test(p))) {
    for (const m of readFileSync(f, "utf8").matchAll(/\bt\(\s*(["'`])([\w.:-]+)\1/g)) used.add(m[2]!);
    for (const m of readFileSync(f, "utf8").matchAll(/\bt\(\s*`([\w.:-]*)\$\{/g)) assert.ok(Object.keys(en).some((k) => k.startsWith(m[1]!)), `no keys with prefix ${m[1]}`);
  }
  assert.deepEqual([...used].filter((k) => !(k in en)), []);
});

test("every catalog key is used (no dead strings)", () => {
  const root = new URL("../../apps/web/src", import.meta.url).pathname;
  const src = walk(root).filter((p) => /\.tsx?$/.test(p)).map((p) => readFileSync(p, "utf8")).join("\n");
  const dynamicPrefixes = [...src.matchAll(/\bt\(\s*`([\w.:-]*)\$\{/g)].map((m) => m[1]!);
  const dead = Object.keys(en).filter((k) => !src.includes(`"${k}"`) && !dynamicPrefixes.some((p) => k.startsWith(p)));
  assert.deepEqual(dead, []);
});
