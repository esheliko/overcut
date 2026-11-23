import { useEffect, useRef } from "react";
import type { Project, ProjectLibrary } from "@app/engine-client";
import { TICKS, timelineEnd } from "../media/plan";

const THUMB_WIDTH = 240;
const cache = new Map<string, string | null>();

/** A small JPEG data URL of a poster (an object URL of the bin); null when it cannot be read. Cached by URL. */
async function thumbOf(url: string): Promise<string | null> {
  if (cache.has(url)) return cache.get(url)!;
  let out: string | null = null;
  try {
    // an <img> (not fetch: the page's CSP allows blob: images, not blob: connections)
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = Math.min(THUMB_WIDTH, img.naturalWidth);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = Math.max(1, Math.round((img.naturalHeight * w) / img.naturalWidth));
    c.getContext("2d")?.drawImage(img, 0, 0, c.width, c.height);
    out = c.toDataURL("image/jpeg", 0.7);
  } catch {
    out = null;
  }
  cache.set(url, out);
  return out;
}

/**
 * Keeps this project's row in the Projects home current: length, size, frame rate, last edited and a thumbnail of the first picture.
 * Runs a moment after the last change; opening a project alone does not count as an edit. Fails soft (the list is a convenience).
 */
export function useProjectMeta(library: ProjectLibrary, id: string | null, project: Project | null, posterOf: (mediaId: string) => string | undefined) {
  const seen = useRef<string | null>(null);
  const poster = useRef(posterOf);
  poster.current = posterOf;
  useEffect(() => {
    if (!id || !project) return;
    const first = seen.current !== id;
    seen.current = id;
    const write = () => {
      const seq = project.sequences[0];
      const firstClip = seq?.tracks.flatMap((t) => t.clips).filter((c) => project.media.find((m) => m.id === c.media)?.kind !== "audio").sort((a, b) => a.start - b.start)[0];
      const url = firstClip ? poster.current(firstClip.media) : undefined;
      const known = library.get(id);
      library.upsert(id, {
        name: known?.name ?? project.name,
        seconds: timelineEnd(project) / TICKS,
        width: seq?.resolution.width ?? 0,
        height: seq?.resolution.height ?? 0,
        fps: seq ? seq.frame_rate.num / seq.frame_rate.den : 0,
        thumb: (url && cache.get(url)) || (firstClip ? known?.thumb ?? null : null),
        updatedAt: first && known ? known.updatedAt : Date.now(),
      });
      // the picture itself is read a moment later and added to the row
      if (url && !cache.has(url)) void thumbOf(url).then((thumb) => thumb && library.upsert(id, { thumb, updatedAt: library.get(id)?.updatedAt ?? Date.now() }));
    };
    if (first) { write(); return; } // a project that was just opened is listed at once (the home may be opened next)
    const timer = setTimeout(write, 1200);
    // leaving (another project, the home) must not lose the last change: write now instead of cancelling
    return () => { clearTimeout(timer); write(); };
  }, [library, id, project]);
}
