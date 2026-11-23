import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BREAKPOINTS, profileFor } from "../../apps/web/src/layout/profiles";

const css = readFileSync(new URL("../../apps/web/src/styles.css", import.meta.url), "utf8");
const queries = [...css.matchAll(/@container editor \(([^{]+)\)\s*\{/g)].map((m) => m[1]!);

test("each form factor lands in its profile", () => {
  const cases: [number, number, string][] = [
    [320, 568, "phone-portrait"], [390, 844, "phone-portrait"], [719, 1000, "phone-portrait"],
    [844, 390, "phone-landscape"], [667, 375, "phone-landscape"], [932, 430, "phone-landscape"],
    [768, 1024, "tablet"], [1024, 768, "tablet"], [820, 1180, "tablet"], [1000, 501, "tablet"],
    [1280, 800, "desktop"], [1440, 900, "desktop"], [1920, 1080, "desktop"], [1280, 480, "desktop"],
    [3440, 1440, "ultrawide"], [2560, 1080, "ultrawide"],
  ];
  for (const [w, h, want] of cases) assert.equal(profileFor(w, h), want, `${w}x${h}`);
});

test("profile edges: one pixel either side of every breakpoint", () => {
  assert.equal(profileFor(BREAKPOINTS.tablet - 1, 900), "phone-portrait");
  assert.equal(profileFor(BREAKPOINTS.tablet, 900), "tablet");
  assert.equal(profileFor(BREAKPOINTS.desktop - 1, 900), "tablet");
  assert.equal(profileFor(BREAKPOINTS.desktop, 900), "desktop");
  assert.equal(profileFor(BREAKPOINTS.ultrawide, BREAKPOINTS.ultrawide / 2), "ultrawide");
  assert.equal(profileFor(BREAKPOINTS.ultrawide, BREAKPOINTS.ultrawide / 2 + 1), "desktop"); // wide but not 2:1
  assert.equal(profileFor(BREAKPOINTS.landscapeMaxWidth, BREAKPOINTS.landscapeMaxHeight), "phone-landscape");
  assert.equal(profileFor(BREAKPOINTS.landscapeMaxWidth + 1, BREAKPOINTS.landscapeMaxHeight), "tablet");
});

test("styles.css container queries use exactly the breakpoints in profiles.ts", () => {
  const b = BREAKPOINTS;
  assert.ok(queries.some((q) => q === `min-width: ${b.tablet}px`), "tablet");
  assert.ok(queries.some((q) => q === `min-width: ${b.desktop}px`), "desktop");
  assert.ok(queries.some((q) => q.includes(`min-width: ${b.ultrawide}px`) && q.includes("min-aspect-ratio: 2/1")), "ultrawide");
  assert.ok(queries.some((q) => q.includes("orientation: landscape") && q.includes(`max-height: ${b.landscapeMaxHeight}px`) && q.includes(`max-width: ${b.landscapeMaxWidth}px`)), "phone landscape");
  const tokens = readFileSync(new URL("../../apps/web/src/theme/tokens.css", import.meta.url), "utf8");
  assert.ok(tokens.includes(`(max-height: ${b.landscapeMaxHeight}px) and (max-width: ${b.landscapeMaxWidth}px)`), "tokens follow phone landscape");
});

test("the layout is driven by the editor container, not by viewport hacks", () => {
  assert.match(css, /\.editor \{ container: editor \/ size;/);
  assert.equal(/@media[^{]*\.workspace/.test(css), false);
  // the workspace grid is only re-arranged inside container queries
  const outside = css.replace(/@container editor[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  assert.equal(/@media[^{]*\{[^@]*\.workspace \{[^}]*grid-template/.test(outside), false);
});

test("safe-area insets are honoured by the shell and the landscape drawer", () => {
  assert.match(css, /\.editor \{[^}]*env\(safe-area-inset-left\)/);
  assert.match(css, /inset-inline-start: calc\(80px \+ env\(safe-area-inset-left\)\)/);
});
