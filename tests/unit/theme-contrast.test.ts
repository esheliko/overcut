import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** Parses apps/web/src/theme/tokens.css (the single source of truth) and checks WCAG 2.2 contrast per theme. */
const css = readFileSync(new URL("../../apps/web/src/theme/tokens.css", import.meta.url), "utf8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `missing ${selector}`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("\n}", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}
const THEMES = {
  dark: block(":root"),
  light: { ...block(":root"), ...block(':root[data-theme="light"]') },
  "high-contrast": { ...block(":root"), ...block(':root[data-theme="high-contrast"]') },
};

type RGBA = [number, number, number, number];
export function parseColor(v: string): RGBA {
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) { const n = parseInt(m[1]!, 16); return [n >> 16, (n >> 8) & 255, n & 255, 1]; }
  m = /^#([0-9a-f]{3})$/i.exec(v);
  if (m) { const [r, g, b] = [...m[1]!].map((c) => parseInt(c + c, 16)); return [r!, g!, b!, 1]; }
  const r = /^rgba?\(([^)]+)\)$/.exec(v);
  assert.ok(r, `cannot parse colour "${v}"`);
  const p = r[1]!.split(",").map((x) => parseFloat(x));
  return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
}
function over(top: RGBA, base: RGBA): RGBA {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i]! * a + base[i]! * (1 - a)).concat(1) as RGBA;
}
function lum([r, g, b]: RGBA): number {
  const f = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function ratio(a: RGBA, b: RGBA): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** [foreground token, background token, minimum ratio, what it is]. Translucent colours are composited over --surface (or the given base). */
const PAIRS: [string, string, number, string][] = [
  ...["bg", "surface", "surface-2", "surface-3"].flatMap((bg): [string, string, number, string][] => [
    ["fg", bg, 4.5, "body text"],
    ["muted", bg, 4.5, "secondary text"],
  ]),
  ...["bg", "surface", "surface-2"].map((bg): [string, string, number, string] => ["accent", bg, 4.5, "accent text (timecode, selected tool)"]),
  ["accent", "accent-soft", 4.5, "pill / pressed tool"],
  ["accent-ink", "accent", 4.5, "primary button label"],
  ["danger", "surface-2", 4.5, "error text in the status chip"],
  ["bg", "fg", 4.5, "play button, toast"],
  ["bg", "danger", 4.5, "destructive button label (Delete confirm)"],
  ["fg", "surface-3", 4.5, "media bin Tags button label (its own surface-3 fill)"],
  ["stage-fg", "stage", 4.5, "preview hint text"],
  // non-text (3:1): focus ring, status dots
  ["focus-ring", "bg", 3, "focus ring"],
  ["focus-ring", "surface", 3, "focus ring"],
  ["focus-ring", "surface-2", 3, "focus ring"],
  ["ok", "surface-2", 3, "status dot"],
  ["danger", "surface-2", 3, "status dot"],
];

/** Every accent (UX-05) on top of every theme: the overrides in tokens.css, merged over the theme's tokens. Teal is the base set. */
const ACCENT_NAMES = ["teal", "blue", "violet", "pink", "orange", "green", "yellow"];
const SELECTOR = { dark: ':root[data-theme="dark"]', light: ':root[data-theme="light"]', "high-contrast": ':root[data-theme="high-contrast"]' } as const;
const COMBOS: [string, Record<string, string>][] = [];
for (const [theme, tokens] of Object.entries(THEMES)) {
  for (const accent of ACCENT_NAMES) {
    const over = accent === "teal" ? {} : block(`${SELECTOR[theme as keyof typeof SELECTOR]}[data-accent="${accent}"]`);
    COMBOS.push([`${theme} + ${accent}`, { ...tokens, ...over }]);
  }
}

for (const [theme, tokens] of COMBOS) {
  test(`theme ${theme}: every text/background pair meets WCAG 2.2 AA`, () => {
    const get = (name: string): RGBA => {
      let v = tokens[name]!;
      assert.ok(v, `${theme}: missing token --${name}`);
      const ref = /^var\(--([\w-]+)\)$/.exec(v);
      if (ref) v = tokens[ref[1]!]!;
      return parseColor(v);
    };
    const surface = over(get("surface"), [0, 0, 0, 1]);
    const fails: string[] = [];
    for (const [fg, bg, min, what] of PAIRS) {
      const base = bg === "stage" || bg === "accent-soft" ? (bg === "stage" ? [0, 0, 0, 1] as RGBA : surface) : [0, 0, 0, 1] as RGBA;
      const back = over(get(bg), over(base, [0, 0, 0, 1]));
      const front = over(get(fg), back);
      const r = ratio(front, back);
      if (r < min) fails.push(`--${fg} on --${bg} (${what}): ${r.toFixed(2)} < ${min}`);
    }
    assert.deepEqual(fails, []);
  });
}

test("every accent overrides all four accent roles in every theme (no half-set accent)", () => {
  for (const th of Object.values(SELECTOR)) for (const a of ACCENT_NAMES.slice(1)) {
    const o = block(`${th}[data-accent="${a}"]`);
    for (const r of ["accent", "accent-ink", "accent-soft", "clip"]) assert.ok(o[r], `${th} ${a} lacks --${r}`);
  }
});

test("accent names in tokens.css match the picker's list", async () => {
  const { ACCENTS } = await import("../../apps/web/src/theme/theme");
  assert.deepEqual([...ACCENTS], ACCENT_NAMES);
});

test("high-contrast borders are visible (3:1)", () => {
  const t = THEMES["high-contrast"];
  const bg = parseColor(t.surface!);
  assert.ok(ratio(over(parseColor(t["line-strong"]!), bg), bg) >= 3);
  assert.ok(ratio(over(parseColor(t.line!), bg), bg) >= 3);
});

/** The media bin's Tags button had no surface of its own (browser chrome, 1.92:1 in dark). Its CSS must paint a fill, a border and the --fg label. */
test("media bin Tags button paints its own visible surface: surface-3 fill, a border, --fg label", () => {
  const styles = readFileSync(new URL("../../apps/web/src/styles.css", import.meta.url), "utf8");
  const m = /\.bin-tag-btn \{([^}]*)\}/.exec(styles);
  assert.ok(m, "missing .bin-tag-btn rule");
  const rule = m[1]!;
  assert.match(rule, /background:\s*var\(--surface-3\)/);
  assert.match(rule, /border:\s*1px solid var\(--line-strong\)/);
  assert.match(rule, /color:\s*var\(--fg\)/);
});

/** Primary (.export-go) buttons are filled with the accent, and the destructive variant with the danger token, in every theme. */
test("primary and destructive buttons: accent / danger fills with the matching ink, no browser border", () => {
  const styles = readFileSync(new URL("../../apps/web/src/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.export-go \{ background: var\(--accent\); color: var\(--accent-ink\); border: 0; \}/);
  assert.match(styles, /\.export-go\.export-danger-go \{ background: var\(--danger\); color: var\(--bg\); \}/);
});

test("all themes define the same colour roles", () => {
  const roles = ["bg", "surface", "surface-2", "surface-3", "line", "line-strong", "fg", "muted", "accent", "accent-ink", "accent-soft", "danger", "ok", "stage", "stage-fg", "clip", "shadow", "focus-ring"];
  for (const [theme, tokens] of Object.entries(THEMES)) for (const r of roles) assert.ok(tokens[r], `${theme} lacks --${r}`);
});

test("the dark theme keeps the original shell colours", () => {
  const d = THEMES.dark;
  assert.equal(d.bg, "#08080a");
  assert.equal(d.surface, "#131316");
  assert.equal(d.accent, "#2de2d6");
  assert.equal(d.fg, "#f4f4f6");
});

test("reduced motion zeroes every duration token", () => {
  const m = /@media \(prefers-reduced-motion: reduce\) \{\s*:root \{([^}]*)\}/.exec(css);
  assert.ok(m);
  for (const d of ["dur-instant", "dur-fast", "dur-base", "dur-slow"]) assert.match(m[1]!, new RegExp(`--${d}: 0s`));
});

test("the shell stylesheet uses tokens: no colour literals, no physical left/right outside LTR islands", () => {
  const shell = readFileSync(new URL("../../apps/web/src/styles.css", import.meta.url), "utf8");
  const stripped = shell.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.deepEqual(stripped.match(/#[0-9a-f]{3,8}\b|rgba?\(/gi) ?? [], [], "use a colour token from theme/tokens.css");
  // Time axis, transport and the centred toast are deliberately LTR / symmetric.
  const island = /^\s*(\.tl-|\.tick|\.lane|\.playhead|\.toast|\.sr-only|\.visually-hidden|\.transport)/;
  const physical = /(margin|padding|border)-(left|right)|text-align:\s*(left|right)|[\s{;](left|right):|float:\s*(left|right)/;
  const bad = stripped.split("\n").filter((l) => !island.test(l) && physical.test(l));
  assert.deepEqual(bad, [], "use logical properties (inline-start/end) so RTL mirrors");
});
