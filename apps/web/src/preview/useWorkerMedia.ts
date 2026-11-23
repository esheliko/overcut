import type { Project } from "@app/engine-client";
import { useEffect, useRef } from "react";
import { fingerprint } from "../media/cache";
import { pathOf } from "../media/sources";
import type { PreviewHost } from "./host";

/**
 * Hands the preview Worker the file behind every audio/video media item of the shared project (the bin owns the files, the Worker opens its own
 * decoders from them), and tells it when an item leaves the project (undo of an import). Stills are not decoded by the engine and are skipped.
 * `hostVersion` bumps when a (new) Worker is attached, so everything is sent again.
 */
export function useWorkerMedia(host: PreviewHost | null, project: Project | null, fileOf: (id: string) => Promise<File | null>, hostVersion: number, readyIds = ""): void {
  const sent = useRef(new Set<string>());
  const asking = useRef(new Set<string>());
  const fileRef = useRef(fileOf);
  fileRef.current = fileOf;
  const last = useRef<PreviewHost | null>(null);

  useEffect(() => {
    if (!host || !project) return;
    if (last.current !== host) { last.current = host; sent.current.clear(); asking.current.clear(); }
    const wanted = new Set(project.media.filter((m) => m.kind !== "image").map((m) => m.id));
    for (const id of [...sent.current]) {
      if (wanted.has(id)) continue;
      sent.current.delete(id);
      host.send({ type: "unmedia", id });
    }
    for (const id of wanted) {
      if (sent.current.has(id) || asking.current.has(id)) continue;
      asking.current.add(id);
      void (async () => {
        try {
          const file = await fileRef.current(id);
          if (!file) return; // offline: asked again when the project next changes (relink)
          if (last.current === host) {
            sent.current.add(id);
            // A file that stays on disk (desktop) cannot be cloned into the Worker: it opens the path through the UI thread's native decoder.
            const path = pathOf(file);
            const ref = project.media.find((m) => m.id === id);
            host.send(path ? { type: "media-native", id, path } : { type: "media", id, file, fp: `${ref ? fingerprint(ref) : `n-${file.name}`}-${file.size}` });
          }
        } catch {
          /* the clip shows black; the bin already says when a file cannot be read */
        } finally {
          asking.current.delete(id);
        }
      })();
    }
  }, [host, project, hostVersion, readyIds]); // readyIds: a relink changes no project data but makes a file available
}
