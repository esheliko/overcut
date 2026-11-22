import type { Editing, EditOutcome, Op } from "./types";
import type { Project } from "./model.generated";

/** What each backend supplies: the engine's string-in, string-out editor calls. Rejections/throws carry the engine's message. */
export interface RawEditing {
  open(projectJson: string): Promise<void> | void;
  apply(opsJson: string, coalesce: number | undefined): Promise<string> | string;
  undo(): Promise<string> | string;
  redo(): Promise<string> | string;
  project(): Promise<string> | string;
  journal(): Promise<string> | string;
}

export function parseEditOutcome(json: string): EditOutcome {
  const v: unknown = JSON.parse(json);
  if (!v || typeof v !== "object") throw new Error("edit outcome is not an object");
  const o = v as Record<string, unknown>;
  if (typeof o.revision !== "number" || typeof o.can_undo !== "boolean" || typeof o.can_redo !== "boolean" || typeof o.changed !== "boolean") {
    throw new Error("edit outcome has the wrong shape");
  }
  return { revision: o.revision, can_undo: o.can_undo, can_redo: o.can_redo, changed: o.changed };
}

/** The coalesce key crosses as a u32. */
function checkKey(key: number | undefined): number | undefined {
  if (key === undefined) return undefined;
  if (!Number.isInteger(key) || key < 0 || key > 0xffff_ffff) throw new Error("coalesce key must be an integer in 0..2^32-1");
  return key;
}

async function call<T>(f: () => Promise<T> | T): Promise<T> {
  try {
    return await f();
  } catch (e) {
    // wasm-bindgen throws the engine's string, Tauri rejects with it: make it a real Error either way.
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/** One implementation of `Editing` over either backend's raw calls, so both behave identically. */
export function createEditing(raw: RawEditing): Editing {
  return {
    open: (project: Project) => call(() => raw.open(JSON.stringify(project))),
    apply: (ops: Op | Op[], coalesce?: number) => call(async () => parseEditOutcome(await raw.apply(JSON.stringify(ops), checkKey(coalesce)))),
    undo: () => call(async () => parseEditOutcome(await raw.undo())),
    redo: () => call(async () => parseEditOutcome(await raw.redo())),
    project: () => call(async () => JSON.parse(await raw.project()) as Project),
    journal: () => call(async () => raw.journal()),
  };
}
