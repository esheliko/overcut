import type { Engine, MediaHandle, Project } from "@app/engine-client";
import { useEffect, useRef, useState } from "react";

/**
 * The decoder handles the player reads, one per audio/video media item of the shared project. Opened lazily from the bin's file for that
 * item (the bin owns the files), closed when the item leaves the project (undo of an import), all closed on unmount. `version` bumps when
 * the set of open handles changes so the player can redraw with the new picture. Stills are not decoded by the engine and are skipped.
 */
export function useMediaHandles(engine: Engine | null, project: Project | null, fileOf: (id: string) => Promise<File | null>) {
  const handles = useRef(new Map<string, MediaHandle>());
  const opening = useRef(new Set<string>());
  const [version, setVersion] = useState(0);
  const fileRef = useRef(fileOf);
  fileRef.current = fileOf;

  useEffect(() => {
    if (!engine || !project) return;
    const wanted = new Set(project.media.filter((m) => m.kind !== "image").map((m) => m.id));
    let changed = false;
    for (const [id, h] of [...handles.current]) {
      if (wanted.has(id)) continue;
      handles.current.delete(id);
      void h.close();
      changed = true;
    }
    if (changed) setVersion((v) => v + 1);
    for (const id of wanted) {
      if (handles.current.has(id) || opening.current.has(id)) continue;
      opening.current.add(id);
      void (async () => {
        try {
          const file = await fileRef.current(id);
          if (!file) return; // offline: tried again when the project next changes (relink)
          const h = await engine.media.open(file, { audioRate: 48_000 });
          if (handles.current.has(id)) return void h.close();
          handles.current.set(id, h);
          setVersion((v) => v + 1);
        } catch {
          /* the clip shows black; the bin already says when a file cannot be read */
        } finally {
          opening.current.delete(id);
        }
      })();
    }
  }, [engine, project]);

  useEffect(() => { const all = handles.current; return () => { for (const h of all.values()) void h.close(); all.clear(); }; }, []);

  return { handles, version };
}
