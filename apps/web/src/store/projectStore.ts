import { applyEditPatch, type Editing, type EditOutcome, type Op, type Project } from "@app/engine-client";
import { createContext, createElement, useContext, useSyncExternalStore, type ReactNode } from "react";

/** What every panel reads. Replaced (never mutated) on each change, so a selector result is stable until its part changes. */
export interface ProjectState {
  /** The engine's project as of the last edit/undo/redo/reload, or null until the session has opened it. */
  readonly project: Project | null;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Selected clip ids; ids that no longer exist are dropped when the project changes. */
  readonly selection: ReadonlySet<string>;
  /** Playhead, in frames of the sequence. */
  readonly playhead: number;
  /** True while an export runs: the project is frozen (edits are refused) but playback, selection and scrubbing still work. */
  readonly readOnly: boolean;
  /** What the next Undo / Redo would do, in the user's words ("import of clip.mp4"); null when unknown (an unlabelled edit, a recovered history). */
  readonly undoLabel: string | null;
  readonly redoLabel: string | null;
  /** The session's undo steps, oldest first, in the user's words (null = an edit with no name); the last one is what Undo does next. History from before the session (a recovery) is not listed: see `earlierEdits`. */
  readonly undoSteps: readonly (string | null)[];
  /** Undone steps, next Redo first. */
  readonly redoSteps: readonly (string | null)[];
  /** True when the engine can undo more than the listed steps (a recovered session): the history panel shows one "earlier edits" row. */
  readonly earlierEdits: boolean;
}

type Listener = () => void;
const NO_SELECTION: ReadonlySet<string> = new Set();
const NO_STEPS: readonly (string | null)[] = [];

/**
 * The ONE copy of the open project in the UI (M1-024). Fed only by `Engine.editing` outcomes (through the autosaving project session
 * when there is one); panels read it with `useProjectStore(selector)` and change the project only through `apply`/`undo`/`redo`
 * (ADR 0006). Calls are serialised so the engine sees them in the order the user made them. Selection and playhead live here too so
 * the bin, timeline, preview and transport cannot disagree.
 */
export class ProjectStore {
  private state: ProjectState = { project: null, canUndo: false, canRedo: false, selection: NO_SELECTION, playhead: 0, readOnly: false, undoLabel: null, redoLabel: null, undoSteps: NO_STEPS, redoSteps: NO_STEPS, earlierEdits: false };
  private listeners = new Set<Listener>();
  private chain: Promise<unknown> = Promise.resolve();
  private editing: Editing | null = null;
  private token = 0;
  // Labels of the undo / redo steps made in this session (top = next); history from before (a recovered session) has no entry and reads as unlabelled.
  private undoStack: (string | null)[] = [];
  private redoStack: (string | null)[] = [];
  private lastCoalesce: number | undefined;
  private recovered = false; // the engine held history before this session's first edit
  private rev: number | null = null; // the engine revision `state.project` reflects (null until the first outcome after a read)

  readonly getState = (): ProjectState => this.state;

  readonly subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };

  private set(patch: Partial<ProjectState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of [...this.listeners]) l();
  }

  /**
   * Point the store at an engine edit surface (or none) and read its project. Call again with the same surface to re-read it (undo recovery).
   * `history` says what the engine can already undo/redo at this moment (a recovered session has history before the first edit); default none.
   */
  attach(editing: Editing | null, history: { canUndo?: boolean; canRedo?: boolean } = {}): Promise<void> {
    const mine = ++this.token;
    this.editing = editing;
    this.undoStack = [];
    this.redoStack = [];
    this.lastCoalesce = undefined;
    this.recovered = history.canUndo ?? false;
    this.rev = null;
    if (!editing) {
      this.set({ project: null, canUndo: false, canRedo: false, selection: NO_SELECTION, undoLabel: null, redoLabel: null, undoSteps: NO_STEPS, redoSteps: NO_STEPS, earlierEdits: false });
      return Promise.resolve();
    }
    return this.enqueue(async () => {
      const project = await editing.project().catch(() => null); // no project open yet: stay empty until the opener calls reload()
      if (project && this.token === mine) this.set({ project, canUndo: history.canUndo ?? false, canRedo: history.canRedo ?? false, selection: this.pruned(project), undoLabel: null, redoLabel: null, undoSteps: NO_STEPS, redoSteps: NO_STEPS, earlierEdits: history.canUndo ?? false });
    });
  }

  /** Re-read the engine's project (after something outside the store changed it, such as opening a new project). */
  reload(): Promise<void> {
    return this.attach(this.editing);
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.chain.then(job, job);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private run(call: (e: Editing) => Promise<EditOutcome>, history?: (changed: boolean) => void): Promise<EditOutcome | null> {
    const ed = this.editing;
    if (!ed || this.state.readOnly) return Promise.resolve(null);
    const mine = this.token;
    return this.enqueue(async () => {
      const out = await call(ed);
      if (this.token !== mine) return out;
      const project = out.changed ? await this.next(ed, this.state.project, out) : null;
      if (this.token !== mine) return out;
      history?.(out.changed);
      this.publish(project, out);
      return out;
    });
  }

  /**
   * The project after `out`: the engine's patch applied to our copy (every unchanged track and clip keeps its identity, nothing is re-read or
   * re-parsed: ADR 0020), or the whole project when there is no patch, it does not fit, or the revisions are not consecutive (something else
   * changed the engine's project since we last looked).
   */
  private async next(ed: Editing, cur: Project | null, out: EditOutcome): Promise<Project> {
    const ok = cur && out.patch && (this.rev === null || out.revision === this.rev + 1);
    this.rev = out.revision;
    if (ok) {
      try { return applyEditPatch(cur, out.patch!); } catch { /* does not fit: re-read below */ }
    }
    return ed.project();
  }

  /** Show an engine outcome: the new project (when it changed), undo/redo state and the step lists. */
  private publish(project: Project | null, out: EditOutcome): void {
    const top = (st: (string | null)[]) => st[st.length - 1] ?? null;
    this.set({ project: project ?? this.state.project, canUndo: out.can_undo, canRedo: out.can_redo, ...(project ? { selection: this.pruned(project) } : null),
      undoLabel: out.can_undo ? top(this.undoStack) : null, redoLabel: out.can_redo ? top(this.redoStack) : null,
      undoSteps: [...this.undoStack], redoSteps: [...this.redoStack].reverse(), earlierEdits: this.recovered && out.can_undo });
  }

  /**
   * Jump in the history: `position` is how many of the session's steps stay applied (0 = before the first listed step, `undoSteps.length` = now,
   * `undoSteps.length + redoSteps.length` = everything redone). Undoes or redoes the difference in ONE queued job, so edits made meanwhile cannot interleave.
   */
  readonly jumpTo = (position: number): Promise<EditOutcome | null> => {
    const ed = this.editing;
    if (!ed || this.state.readOnly) return Promise.resolve(null);
    const mine = this.token;
    const target = Math.max(0, Math.min(position, this.undoStack.length + this.redoStack.length));
    return this.enqueue(async () => {
      let out: EditOutcome | null = null;
      let moved = false;
      let proj: Project | null = this.state.project; // our copy with every step's patch applied; null once a step had none
      while (this.token === mine) {
        const pos = this.undoStack.length;
        if (pos === target) break;
        const back = pos > target;
        const o = back ? await ed.undo() : await ed.redo();
        out = o;
        if (!o.changed) break;
        moved = true;
        const ok = proj && o.patch && (this.rev === null || o.revision === this.rev + 1);
        this.rev = o.revision;
        try { proj = ok ? applyEditPatch(proj!, o.patch!) : null; } catch { proj = null; }
        if (back) this.redoStack.push(this.undoStack.pop() ?? null);
        else this.undoStack.push(this.redoStack.pop() ?? null);
      }
      this.lastCoalesce = undefined;
      if (this.token !== mine || !out || !moved) return out;
      this.publish(proj ?? (await ed.project()), out);
      return out;
    });
  };

  /** `label` names the step for the Undo / Redo controls ("import of clip.mp4"); omit it for edits that need no name. */
  readonly apply = (ops: Op | Op[], coalesce?: number, label?: string) => this.run((e) => e.apply(ops, coalesce), (changed) => {
    if (!changed) return;
    const merged = coalesce !== undefined && coalesce === this.lastCoalesce && this.undoStack.length > 0; // same undo step as the one before
    if (!merged) this.undoStack.push(label ?? null);
    this.lastCoalesce = coalesce;
    this.redoStack = [];
  });
  readonly undo = () => this.run((e) => e.undo(), (changed) => { if (changed) { this.redoStack.push(this.undoStack.pop() ?? null); this.lastCoalesce = undefined; } });
  readonly redo = () => this.run((e) => e.redo(), (changed) => { if (changed) { this.undoStack.push(this.redoStack.pop() ?? null); this.lastCoalesce = undefined; } });

  readonly setSelection = (selection: ReadonlySet<string>): void => {
    if (selection !== this.state.selection) this.set({ selection: selection.size === 0 ? NO_SELECTION : selection });
  };

  /** Freeze or thaw the project (an export snapshots it, so edits made meanwhile would not be in the file). Edits already queued still finish. */
  readonly setReadOnly = (readOnly: boolean): void => {
    if (readOnly !== this.state.readOnly) this.set({ readOnly });
  };

  readonly setPlayhead = (playhead: number): void => {
    if (playhead !== this.state.playhead) this.set({ playhead });
  };

  /** Selection without the clips a change removed (undo of a split, delete...). Returns the same set when nothing was lost. */
  private pruned(project: Project): ReadonlySet<string> {
    const sel = this.state.selection;
    if (sel.size === 0) return sel;
    const alive = new Set<string>();
    for (const s of project.sequences) for (const t of s.tracks) for (const c of t.clips) if (sel.has(c.id)) alive.add(c.id);
    return alive.size === sel.size ? sel : alive.size === 0 ? NO_SELECTION : alive;
  }
}

const Ctx = createContext<ProjectStore | null>(null);

export function ProjectStoreProvider({ store, children }: { store: ProjectStore; children: ReactNode }) {
  return createElement(Ctx.Provider, { value: store }, children);
}

export function useStore(): ProjectStore {
  const s = useContext(Ctx);
  if (!s) throw new Error("ProjectStoreProvider is missing");
  return s;
}

/** Subscribe to one part of the state. The selector must return the same value while that part is unchanged (pick a field, do not build objects). */
export function useProjectStore<T>(selector: (s: ProjectState) => T): T {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()), () => selector(store.getState()));
}
