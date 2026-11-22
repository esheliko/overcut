import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createAnnouncer, type Priority } from "../../apps/web/src/a11y/announcer";
import { nextRovingIndex } from "../../apps/web/src/a11y/roving";
import { VisuallyHidden } from "../../apps/web/src/a11y/VisuallyHidden";

function rig() {
  const text: Record<Priority, string> = { polite: "", assertive: "" };
  const log: string[] = [];
  const queue: (() => void)[] = [];
  const region = (p: Priority) => ({ setText: (s: string) => { text[p] = s; log.push(`${p}:${s}`); } });
  const a = createAnnouncer({ polite: region("polite"), assertive: region("assertive") }, (fn) => void queue.push(fn));
  return { a, text, log, flush: () => { while (queue.length) queue.shift()!(); } };
}

test("announcer clears, then fills the region on the next tick", () => {
  const { a, text, flush } = rig();
  a.announce("Saved");
  assert.equal(text.polite, "");
  flush();
  assert.equal(text.polite, "Saved");
});

test("announcer routes priority to separate regions", () => {
  const { a, text, flush } = rig();
  a.announce("Heads up", "assertive");
  flush();
  assert.equal(text.assertive, "Heads up");
  assert.equal(text.polite, "");
});

test("announcer repeats an identical message so it is read again", () => {
  const { a, text, flush } = rig();
  a.announce("Copied");
  flush();
  const first = text.polite;
  a.announce("Copied");
  flush();
  assert.notEqual(text.polite, first);
  assert.equal(text.polite.trim(), "Copied");
  a.announce("Copied");
  flush();
  assert.equal(text.polite, first);
});

test("announcer ignores empty messages and clear() empties both regions", () => {
  const { a, text, flush, log } = rig();
  a.announce("   ");
  flush();
  assert.equal(log.length, 0);
  a.announce("x");
  flush();
  a.clear();
  assert.deepEqual([text.polite, text.assertive], ["", ""]);
});

test("roving tabindex: arrows move and wrap, Home/End jump", () => {
  assert.equal(nextRovingIndex(0, "ArrowRight", 3), 1);
  assert.equal(nextRovingIndex(2, "ArrowRight", 3), 0);
  assert.equal(nextRovingIndex(0, "ArrowLeft", 3), 2);
  assert.equal(nextRovingIndex(1, "Home", 3), 0);
  assert.equal(nextRovingIndex(1, "End", 3), 2);
  assert.equal(nextRovingIndex(2, "ArrowRight", 3, { loop: false }), 2);
  assert.equal(nextRovingIndex(0, "ArrowLeft", 3, { loop: false }), 0);
});

test("roving tabindex: RTL swaps horizontal arrows; orientation limits keys; others are not handled", () => {
  assert.equal(nextRovingIndex(1, "ArrowRight", 3, { rtl: true }), 0);
  assert.equal(nextRovingIndex(1, "ArrowLeft", 3, { rtl: true }), 2);
  assert.equal(nextRovingIndex(1, "ArrowDown", 3), null);
  assert.equal(nextRovingIndex(1, "ArrowDown", 3, { orientation: "vertical" }), 2);
  assert.equal(nextRovingIndex(1, "ArrowRight", 3, { orientation: "vertical" }), null);
  assert.equal(nextRovingIndex(1, "ArrowDown", 3, { orientation: "both" }), 2);
  assert.equal(nextRovingIndex(1, "a", 3), null);
  assert.equal(nextRovingIndex(0, "ArrowRight", 0), null);
});

test("VisuallyHidden renders the visually-hidden class and keeps its text", () => {
  assert.equal(renderToStaticMarkup(VisuallyHidden({ children: "Close" })), '<span class="visually-hidden">Close</span>');
});
