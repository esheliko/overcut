/**
 * Crash state and the diagnostics report for the error screen (XT-06, `docs/features/open-with.md` has the sibling PM-02 notes; this one is in
 * `docs/features/error-screen.md`). Pure and framework-free so it is unit tested. Nothing here sends anything anywhere: the report is text the
 * person may copy.
 */
import type { Capabilities } from "@app/engine-client";
import { buildReport } from "../diagnostics/report";

export type SaveStatus = "none" | "saved" | "saving" | "error";
/** What the error screen may promise about the person's work. */
export type WorkState = "saved" | "maybe-lost" | "lost" | "nothing";

let save: SaveStatus = "none";
let app = { version: "unknown", backend: "unknown" };
const recent: { at: string; source: string; message: string }[] = [];

/** `persistence.tsx` reports the journal's state here: `saved` only when every edit made so far is in durable storage. */
export const reportSaveStatus = (s: SaveStatus): void => { save = s; };
export const reportAppInfo = (a: { version: string; backend: string }): void => { app = a; };
export const currentSaveStatus = (): SaveStatus => save;

/** Non-fatal problems (an unhandled promise rejection) are kept for the report but do not stop the app. */
export function noteProblem(source: string, error: unknown, now = new Date()): void {
  recent.push({ at: now.toISOString(), source, message: messageOf(error) });
  if (recent.length > 10) recent.shift();
}
export const resetCrashState = (): void => { save = "none"; app = { version: "unknown", backend: "unknown" }; recent.length = 0; };

export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : typeof e === "string" ? e : (() => { try { return JSON.stringify(e) ?? String(e); } catch { return String(e); } })());

/**
 * What it is honest to say about the work: "saved" only when autosave confirms it; "saving" means the last edits may still be on their way;
 * "error" means autosave is not working so changes since the last file save are at risk; "none" means no project session was ever open.
 */
export function workState(s: SaveStatus): WorkState {
  return s === "saved" ? "saved" : s === "saving" ? "maybe-lost" : s === "error" ? "lost" : "nothing";
}

export interface CrashInfo { source: string; error: unknown; at?: Date }

/** The text behind "Copy diagnostics report": the device report (`diagnostics/report.ts`) plus the error with its stack. The project itself is never included. */
export function buildCrashReport(info: CrashInfo, caps: Capabilities | null = null): string {
  const now = info.at ?? new Date();
  const e = info.error;
  return JSON.stringify({
    overcut_crash_report: 1,
    at: now.toISOString(),
    source: info.source,
    error: { name: e instanceof Error ? e.name : typeof e, message: messageOf(e), stack: e instanceof Error ? e.stack ?? null : null },
    saved: save,
    recent: recent.slice(),
    device: JSON.parse(buildReport(caps, [], app, now)) as unknown,
  });
}
