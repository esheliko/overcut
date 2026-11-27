// R12 phone lane: the keyboard inset maths and the Back-button layer stack (no DOM: a tiny history stand-in).
import assert from "node:assert/strict";
import { test } from "node:test";
import { keyboardInset } from "../../apps/web/src/layout/useKeyboardInset";

test("keyboard inset: a toolbar change is not a keyboard, a real keyboard is its covered height", () => {
  assert.equal(keyboardInset(844, { height: 844, offsetTop: 0 }), 0);
  assert.equal(keyboardInset(844, { height: 790, offsetTop: 0 }), 0); // URL bar collapsing
  assert.equal(keyboardInset(844, { height: 500, offsetTop: 0 }), 344);
  assert.equal(keyboardInset(844, { height: 500, offsetTop: 40 }), 304); // the page scrolled inside the visual viewport
});

test("Back closes the top layer first, then the next; closing by other means takes the entry off", async () => {
  const listeners: Record<string, (e: unknown) => void> = {};
  const entries: { depth?: number }[] = [{}];
  let at = 0;
  const g = globalThis as unknown as Record<string, unknown>;
  g.addEventListener = (n: string, f: (e: unknown) => void) => { listeners[n] = f; };
  g.history = {
    get state() { const d = entries[at]?.depth; return d === undefined ? null : { overcutLayer: d }; },
    pushState(s: { overcutLayer: number }) { entries.splice(at + 1); entries.push({ depth: s.overcutLayer }); at++; },
    back() { at--; queueMicrotask(() => listeners.popstate!({ state: (g.history as { state: unknown }).state })); },
  };
  const { pushLayer } = await import("../../apps/web/src/layout/backStack");
  const closed: string[] = [];
  const press = async () => { at--; listeners.popstate!({ state: (g.history as { state: unknown }).state }); await Promise.resolve(); };
  pushLayer(() => closed.push("sheet"));
  pushLayer(() => closed.push("dialog"));
  await press();
  assert.deepEqual(closed, ["dialog"]);
  await press();
  assert.deepEqual(closed, ["dialog", "sheet"]);
  // closed by its own button: the entry goes, and a following Back has nothing left to close
  const off = pushLayer(() => closed.push("x"));
  off();
  await Promise.resolve();
  assert.equal(at, 0);
  assert.deepEqual(closed, ["dialog", "sheet"]);
});
