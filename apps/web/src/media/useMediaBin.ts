import { MediaDecodeError, type Engine, type MediaKind, type Project } from "@app/engine-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { probeFile } from "./probe";
import { STILL_SECONDS, TICKS, classify, clipCount, emptyProject, extOf, insertOps, mediaRef, newId, placeAt, sequenceFrom, sequenceIsUnset, timelineEnd, withMedia, type Probed } from "./plan";
import { loadHandle, saveHandle, type Source } from "./sources";

export type BinStatus = "probing" | "ready" | "unsupported" | "offline";

/** One card in the bin. `id` is the project's media id for ready/offline items. */
export interface BinItem {
  id: string;
  name: string;
  kind: MediaKind;
  size: number;
  status: BinStatus;
  /** Why it could not be imported (status `unsupported`), already fit to show. */
  message?: string;
  durationTicks?: number | null;
  width?: number;
  height?: number;
  codec?: string;
  poster?: string;
  hasAudio?: boolean;
  uri?: string;
}

/** Strings the hook needs (the UI passes `t`-built text so this file stays free of i18n). */
export interface BinText {
  notMedia: (name: string) => string;
  /** Codec or container the device cannot decode. `detail` is the engine's own sentence. */
  unsupported: (name: string, ext: string, detail: string) => string;
  failed: (name: string) => string;
  imported: (count: number) => string;
  announce: (message: string) => void;
}

interface Live { file: File; probed: Probed }

/**
 * The project's media list and the import flow. The engine owns the project (`Engine.editing`); this hook owns the files, posters and
 * bin state. Every change to the project is queued so concurrent drops cannot interleave.
 */
export function useMediaBin(engine: Engine | null, name: string, text: BinText) {
  const [items, setItems] = useState<BinItem[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const live = useRef(new Map<string, Live>());
  const doc = useRef<Project | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const posters = useRef(new Set<string>());
  const textRef = useRef(text);
  textRef.current = text;
  const nameRef = useRef(name);
  nameRef.current = name;

  const enqueue = useCallback(<T,>(job: () => Promise<T>): Promise<T> => {
    const next = queue.current.then(job, job);
    queue.current = next.catch(() => undefined);
    return next;
  }, []);

  // A fresh empty project as soon as the engine is there: no "new project" dialog.
  useEffect(() => {
    if (!engine) return;
    let alive = true;
    const p = emptyProject(nameRef.current);
    void enqueue(async () => {
      await engine.editing.open(p);
      if (alive) { doc.current = p; setProject(p); }
    });
    return () => { alive = false; };
  }, [engine, enqueue]);

  useEffect(() => { const urls = posters.current; return () => urls.forEach((u) => URL.revokeObjectURL(u)); }, []);

  const patch = useCallback((id: string, change: Partial<BinItem>) => setItems((all) => all.map((i) => (i.id === id ? { ...i, ...change } : i))), []);

  const refresh = useCallback(async (e: Engine) => {
    const next = await e.editing.project();
    doc.current = next;
    setProject(next);
  }, []);

  /** Puts a media item on the timeline (one undo step) at `start` ticks, or at the end when that spot is taken. */
  const place = useCallback(async (e: Engine, id: string, start: number | "end") => {
    const l = live.current.get(id);
    const cur = doc.current;
    const ref = cur?.media.find((m) => m.id === id);
    if (!l || !cur || !ref) return false;
    const len = ref.kind === "image" ? STILL_SECONDS * TICKS : ref.duration ?? 0;
    const at = start === "end" ? timelineEnd(cur) : placeAt(cur, start, len);
    const ops = insertOps(cur, ref, l.probed, at);
    if (!ops) return false;
    await e.editing.apply(ops);
    await refresh(e);
    return true;
  }, [refresh]);

  const importSources = useCallback(async (sources: Source[]): Promise<void> => {
    if (!engine || sources.length === 0) return;
    const t = textRef.current;
    // Show every card at once, probe them one after another so the first import is deterministic.
    const rows = sources.map((s) => ({ s, kind: classify(s.file.name, s.file.type), id: newId() }));
    setItems((all) => [
      ...rows.map<BinItem>((r) => r.kind
        ? { id: r.id, name: r.s.file.name, kind: r.kind, size: r.s.file.size, status: "probing" }
        : { id: r.id, name: r.s.file.name, kind: "video", size: r.s.file.size, status: "unsupported", message: t.notMedia(r.s.file.name) }),
      ...all,
    ]);
    let added = 0;
    for (const r of rows) {
      if (!r.kind) continue;
      const { s, id, kind } = r;
      await enqueue(async () => {
        try {
          const res = await probeFile(engine, s.file, kind);
          if (res.poster) posters.current.add(res.poster);
          const cur = doc.current!;
          const uri = s.handle ? `fs:${id}` : `file:${s.file.name}:${s.file.size}`;
          if (s.handle) await saveHandle(uri, s.handle);
          const first = cur.media.length === 0 && clipCount(cur) === 0;
          const adopt = sequenceIsUnset(cur) ? sequenceFrom(res.probed) : null;
          const next = withMedia(cur, mediaRef(id, s.file.name, uri, res.probed), adopt);
          await engine.editing.open(next); // media is not an edit op yet: this restarts the undo history (docs/features/media-bin.md)
          doc.current = next;
          live.current.set(id, { file: s.file, probed: res.probed });
          patch(id, { status: "ready", durationTicks: res.probed.durationTicks, width: res.probed.width, height: res.probed.height, codec: res.codec, poster: res.poster, hasAudio: res.probed.hasAudio, uri });
          if (first || added > 0) { // the very first import goes straight onto the timeline, every file of that drop in order
            if (await place(engine, id, "end")) added++;
          } else {
            await refresh(engine);
          }
        } catch (e) {
          const ext = extOf(s.file.name).toUpperCase();
          const message = e instanceof MediaDecodeError && e.kind === "unsupported" ? t.unsupported(s.file.name, ext, e.message) : t.failed(s.file.name);
          patch(id, { status: "unsupported", message });
          t.announce(message);
        }
      });
    }
    const ok = rows.filter((r) => r.kind).length;
    if (ok > 0) t.announce(t.imported(ok));
  }, [engine, enqueue, patch, place, refresh]);

  const addToTimeline = useCallback((id: string, start: number | "end" = "end"): Promise<boolean> => {
    if (!engine) return Promise.resolve(false);
    return enqueue(() => place(engine, id, start));
  }, [engine, enqueue, place]);

  const remove = useCallback((id: string) => {
    setItems((all) => {
      const gone = all.find((i) => i.id === id);
      if (gone?.poster) { URL.revokeObjectURL(gone.poster); posters.current.delete(gone.poster); }
      return all.filter((i) => i.id !== id);
    });
  }, []);

  /** Reconnects a file whose bytes are not available (reopened project, revoked permission). */
  const relink = useCallback(async (id: string, source?: Source) => {
    const item = items.find((i) => i.id === id);
    if (!item) return false;
    const file = source?.file ?? (item.uri ? await loadHandle(item.uri, true) : null);
    if (!file || !engine || file.size !== item.size) return false;
    const probed = (await probeFile(engine, file, item.kind)).probed;
    live.current.set(id, { file, probed });
    patch(id, { status: "ready" });
    return true;
  }, [engine, items, patch]);

  /** For project open (M1-040): list a loaded project's media, restoring files from stored handles and marking the rest offline. */
  const adoptProject = useCallback(async (p: Project) => {
    const rows: BinItem[] = [];
    for (const m of p.media) {
      const file = await loadHandle(m.uri);
      rows.push({ id: m.id, name: m.name, kind: m.kind, size: file?.size ?? 0, status: file ? "ready" : "offline", durationTicks: m.duration, uri: m.uri });
    }
    doc.current = p;
    setProject(p);
    setItems(rows);
  }, []);

  return { items, project, importSources, addToTimeline, remove, relink, adoptProject };
}
