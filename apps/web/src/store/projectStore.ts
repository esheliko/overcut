import type { Editing, EditOutcome, Op, Project } from "@app/engine-client";
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
}

type Listener = () => void;
const NO_SELECTION: ReadonlySet<string> = new Set();

/**
 * The ONE copy of the open project in the UI (M1-024). Fed only by `Engine.editing` outcomes (through the autosaving project session
 * when there is one); panels read it with `useProjectStore(selector)` and change the project only through `apply`/`undo`/`redo`
 * (ADR 0006). Calls are serialised so the engine sees them in the order the user made them. Selection and playhead live here too so
 * the bin, timeline, preview and transport cannot disagree.
 */
export class ProjectStore {
  private state: ProjectState = { project: null, canUndo: false, canRedo: false, selection: NO_SELECTION, playhead: 0, readOnly: false, undoLabel: null, redoLabel: null };
  private listeners = new Set<Listener>();
  private chain: Promise<unknown> = Promise.resolve();
  private editing: Editing | null = null;
  private token = 0;
  // Labels of the undo / redo steps made in this session (top = next); history from before (a recovered session) has no entry and reads as unlabelled.
  private undoStack: (string | null)[] = [];
  private redoStack: (string | null)[] = [];
  private lastCoalesce: number | undefined;

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
    if (!editing) {
      this.set({ project: null, canUndo: false, canRedo: false, selection: NO_SELECTION, undoLabel: null, redoLabel: null });
      return Promise.resolve();
    }
    return this.enqueue(async () => {
      const project = await editing.project().catch(() => null); // no project open yet: stay empty until the opener calls reload()
      if (project && this.token === mine) this.set({ project, canUndo: history.canUndo ?? false, canRedo: history.canRedo ?? false, selection: this.pruned(project), undoLabel: null, redoLabel: null });
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
      const project = out.changed ? await ed.project() : null;
      if (this.token !== mine) return out;
      history?.(out.changed);
      const top = (st: (string | null)[]) => st[st.length - 1] ?? null;
      this.set({ project: project ?? this.state.project, canUndo: out.can_undo, canRedo: out.can_redo, ...(project ? { selection: this.pruned(project) } : null),
        undoLabel: out.can_undo ? top(this.undoStack) : null, redoLabel: out.can_redo ? top(this.redoStack) : null });
      return out;
    });
  }

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
