import type { Editing, EditOutcome, Op, Project } from "@app/engine-client";
import { useCallback, useEffect, useRef, useState } from "react";

interface State { project: Project | null; canUndo: boolean; canRedo: boolean }

/** The open project as the UI sees it: a read-only copy refreshed from `Engine.editing` after every change. The UI never edits it directly (ADR 0006);
 *  calls are serialised so the engine sees them in the order the user made them. */
export function useProject(editing: Editing | undefined, epoch = 0) {
  const [state, setState] = useState<State>({ project: null, canUndo: false, canRedo: false });
  const chain = useRef<Promise<unknown>>(Promise.resolve());

  // The persistence session (M1-040) opens the project; we only read it, and again whenever it is replaced under us (`epoch`).
  useEffect(() => {
    if (!editing) { setState({ project: null, canUndo: false, canRedo: false }); return; }
    let alive = true;
    chain.current = chain.current.catch(() => undefined).then(() => editing.project()).then((project) => { if (alive) setState({ project, canUndo: false, canRedo: false }); });
    chain.current.catch(() => undefined);
    return () => { alive = false; };
  }, [editing, epoch]);

  const run = useCallback((call: (e: Editing) => Promise<EditOutcome>): Promise<EditOutcome | null> => {
    if (!editing) return Promise.resolve(null);
    const next = chain.current.then(async () => {
      const out = await call(editing);
      const project = out.changed ? await editing.project() : null;
      setState((s) => ({ project: project ?? s.project, canUndo: out.can_undo, canRedo: out.can_redo }));
      return out;
    });
    chain.current = next.catch(() => undefined);
    return next;
  }, [editing]);

  return {
    project: state.project,
    canUndo: state.canUndo,
    canRedo: state.canRedo,
    ready: !!editing && state.project !== null,
    apply: useCallback((ops: Op | Op[], coalesce?: number) => run((e) => e.apply(ops, coalesce)), [run]),
    undo: useCallback(() => run((e) => e.undo()), [run]),
    redo: useCallback(() => run((e) => e.redo()), [run]),
  };
}
