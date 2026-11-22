import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import ts from "typescript";

/**
 * Fails when a component in apps/web/src hard-codes user-visible English: JSX text, or a string in an
 * accessible-name attribute (aria-label, title, placeholder, alt, ...). Move the string into i18n/en.json and use t("key").
 */
const ROOT = new URL("../../apps/web/src", import.meta.url).pathname;
const ATTRS = new Set(["aria-label", "aria-valuetext", "aria-description", "aria-placeholder", "aria-roledescription", "title", "placeholder", "alt", "label"]);
/** Text that is not a translatable sentence. */
const ALLOWED = new Set<string>([]);

const hasWords = (s: string) => /\p{L}{2,}/u.test(s);

export function findHardcoded(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const report = (node: ts.Node, what: string) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
    out.push(`${relative(ROOT, file)}:${line + 1} ${what}`);
  };
  const literalsIn = (e: ts.Node): ts.Node[] => {
    const found: ts.Node[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) found.push(n);
      // a call such as t("key") is the right thing: do not descend into it
      else if (!ts.isCallExpression(n)) ts.forEachChild(n, visit);
    };
    visit(e);
    return found;
  };
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n)) {
      const s = n.getText().trim();
      if (s && hasWords(s) && !ALLOWED.has(s)) report(n, `JSX text "${s}"`);
    } else if (ts.isJsxAttribute(n) && ATTRS.has(n.name.getText()) && n.initializer) {
      const init = n.initializer;
      const nodes = ts.isStringLiteral(init) ? [init] : ts.isJsxExpression(init) && init.expression ? literalsIn(init.expression) : [];
      for (const l of nodes) {
        const s = (l as ts.StringLiteralLike).text ?? l.getText();
        if (hasWords(s) && !ALLOWED.has(s)) report(l, `${n.name.getText()}="${s}"`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
}

test("no hard-coded user-visible strings in apps/web components (use t(\"key\") and i18n/en.json)", () => {
  const files = walk(ROOT).filter((p) => p.endsWith(".tsx") && !p.endsWith("icons.tsx"));
  const found = files.flatMap((f) => findHardcoded(f, readFileSync(f, "utf8")));
  assert.deepEqual(found, [], "move these strings into apps/web/src/i18n/en.json and render them with t(\"key\")");
});

test("the detector catches JSX text, attributes and template strings, and accepts t() calls", () => {
  const bad = `export const A = () => <button aria-label="Save" title={\`Go \${x}\`}>Click me<span>{t("a.b")}</span></button>;`;
  assert.equal(findHardcoded("/x/A.tsx", bad).length, 3);
  const ok = `export const A = () => <button aria-label={t("a.b")} title={t("c", { n: "x" })}>{t("d")}<Icon name="x" /> · </button>;`;
  assert.deepEqual(findHardcoded("/x/A.tsx", ok), []);
});
