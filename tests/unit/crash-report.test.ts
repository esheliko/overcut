import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { buildCrashReport, currentSaveStatus, noteProblem, reportAppInfo, reportSaveStatus, resetCrashState, workState } from "../../apps/web/src/errorScreen/crash";

beforeEach(resetCrashState);

test("the screen only says the work is saved when autosave confirms it", () => {
  assert.equal(currentSaveStatus(), "none");
  assert.equal(workState("saved"), "saved");
  assert.equal(workState("saving"), "maybe-lost");
  assert.equal(workState("error"), "lost");
  assert.equal(workState("none"), "nothing");
});

test("the report carries the error with its stack, the save state and the device report, and no project data", () => {
  reportAppInfo({ version: "0.1.0", backend: "wasm" });
  reportSaveStatus("saving");
  noteProblem("unhandled-rejection", new Error("earlier problem"), new Date("2026-11-24T10:00:00Z"));
  const err = new TypeError("boom");
  const r = JSON.parse(buildCrashReport({ source: "render", error: err, at: new Date("2026-11-24T10:01:00Z") })) as { overcut_crash_report: number; source: string; saved: string; at: string; error: { name: string; message: string; stack: string }; recent: { message: string }[]; device: { overcut_device_report: number; app: string } };
  assert.equal(r.overcut_crash_report, 1);
  assert.equal(r.source, "render");
  assert.equal(r.error.name, "TypeError");
  assert.equal(r.error.message, "boom");
  assert.match(r.error.stack, /boom/);
  assert.equal(r.saved, "saving");
  assert.equal(r.recent[0]?.message, "earlier problem");
  assert.equal(r.device.overcut_device_report, 1); // the /diagnostics builder
  assert.equal(r.device.app, "0.1.0 wasm");
  assert.equal(r.at, "2026-11-24T10:01:00.000Z");
});

test("anything can be thrown: strings and objects still make a report", () => {
  assert.equal((JSON.parse(buildCrashReport({ source: "uncaught", error: "plain text" })) as { error: { message: string } }).error.message, "plain text");
  const cyc: Record<string, unknown> = {}; cyc.self = cyc;
  assert.doesNotThrow(() => buildCrashReport({ source: "uncaught", error: cyc }));
});

test("the list of earlier problems stays short", () => {
  for (let i = 0; i < 25; i++) noteProblem("x", i);
  assert.equal((JSON.parse(buildCrashReport({ source: "s", error: 1 })) as { recent: unknown[] }).recent.length, 10);
});
