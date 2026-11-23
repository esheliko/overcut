import { MediaDecodeError, fingerprintFile, fingerprintSize, newProject, type Editing, type Engine, type MediaKind, type Op, type Project } from "@app/engine-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { probeFile } from "./probe";
import { STILL_SECONDS, TICKS, classify, clipCount, extOf, importOps, insertOps, mediaRef, newId, placeAt, timelineEnd, type Probed } from "./plan";
import { loadHandle, pathOf, saveHandle, type Source } from "./sources";
import { useProjectStore, useStore } from "../store/projectStore";

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
 * The project's media list and the import flow. The engine owns the project and the shared store (`store/projectStore.ts`) mirrors it: every
 * change is an edit op through the store, so undo, redo and crash recovery cover imports and every panel follows. This hook owns the files,
 * posters and bin state, and re-derives the bin's cards whenever the shared project changes (so undo of an import removes its card).
 * Changes are queued so concurrent drops cannot interleave.
 */
export function useMediaBin(engine: Engine | null, ed: Editing | null, opened: boolean, name: string, text: BinText) {
  const [items, setItems] = useState<BinItem[]>([]);
  const store = useStore();
  const project = useProjectStore((s) => s.project);
  const live = useRef(new Map<string, Live>());
  /** Cards of media that left the project (undo of an import) kept so redo brings them back whole, poster included. */
  const cards = useRef(new Map<string, BinItem>());
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const posters = useRef(new Set<string>());
  /** Files dropped before the project is open (the editing session starts asynchronously): imported as soon as it is. */
  const pending = useRef<Source[]>([]);
  const importRef = useRef<(s: Source[]) => Promise<void>>(() => Promise.resolve());
  const textRef = useRef(text);
  textRef.current = text;
  const nameRef = useRef(name);
  nameRef.current = name;

  const enqueue = useCallback(<T,>(job: () => Promise<T>): Promise<T> => {
    const next = queue.current.then(job, job);
    queue.current = next.catch(() => undefined);
    return next;
  }, []);

  const adopt = useCallback(async (p: Project) => {
    const known = new Set(p.media.map((m) => m.id));
    setItems((all) => {
      for (const i of all) if (i.status === "ready" && !known.has(i.id)) cards.current.set(i.id, i);
      const kept = all.filter((i) => i.status === "probing" || i.status === "unsupported" || known.has(i.id));
      const have = new Set(kept.map((i) => i.id));
      const fresh = p.media.filter((m) => !have.has(m.id)).map<BinItem>((m) => cards.current.get(m.id) ?? ({
        id: m.id, name: m.name, kind: m.kind, size: fingerprintSize(m.hash ?? "") ?? 0, status: "offline", durationTicks: m.duration, uri: m.uri,
      }));
      return [...fresh, ...kept];
    });
    // A reopened project: files whose stored handle still has permission come back by themselves; the rest show "Relink".
    for (const m of p.media) {
      if (live.current.has(m.id)) continue;
      const file = await loadHandle(m.uri);
      // A file found by its stored path must still be the same file (size from the fingerprint); otherwise it shows "Relink".
      const sameSize = !m.uri.startsWith("path:") || !m.hash || fingerprintSize(m.hash) === file?.size;
      if (file && sameSize) setItems((all) => all.map((i) => (i.id === m.id && i.status === "offline" ? { ...i, status: "ready", size: file.size } : i)));
    }
  }, []);

  // Without a persistence session (storage unavailable) the bare engine needs a project to edit: open an empty one, then read it into the store.
  useEffect(() => {
    if (!ed || opened) return;
    let alive = true;
    void enqueue(async () => { if (alive) { await ed.open(newProject(nameRef.current)); await store.reload(); } }).catch(() => undefined);
    return () => { alive = false; };
  }, [ed, opened, store, enqueue]);

  // The shared project changed (import, undo, redo, recovery): the cards follow it. Files dropped before the project was there come in now.
  useEffect(() => {
    if (!project) return;
    let alive = true;
    void adopt(project).then(() => { const early = pending.current.splice(0); if (alive && early.length > 0) void importRef.current(early); });
    return () => { alive = false; };
  }, [project, adopt]);

  useEffect(() => { const urls = posters.current; return () => urls.forEach((u) => URL.revokeObjectURL(u)); }, []);

  const patch = useCallback((id: string, change: Partial<BinItem>) => setItems((all) => all.map((i) => (i.id === id ? { ...i, ...change } : i))), []);


  /** The file behind a media entry: the live one, else (reopened project) the stored handle, probed on first use. */
  const fileFor = useCallback(async (id: string, uri: string, kind: MediaKind): Promise<Live | null> => {
    const have = live.current.get(id);
    if (have) return have;
    const file = await loadHandle(uri);
    if (!file || !engine) return null;
    const l = { file, probed: (await probeFile(engine, file, kind)).probed };
    live.current.set(id, l);
    return l;
  }, [engine]);

  /** Ops for putting a media item on the timeline: `at` ticks, or after the last clip when that spot is taken. */
  const timelineOps = useCallback(async (cur: Project, id: string, start: number | "end"): Promise<Op[] | null> => {
    const ref = cur.media.find((m) => m.id === id);
    const l = ref && (await fileFor(id, ref.uri, ref.kind));
    if (!ref || !l) return null;
    const len = ref.kind === "image" ? STILL_SECONDS * TICKS : ref.duration ?? 0;
    return insertOps(cur, ref, l.probed, start === "end" ? timelineEnd(cur) : placeAt(cur, start, len));
  }, [fileFor]);

  const importSources = useCallback(async (sources: Source[]): Promise<void> => {
    if (sources.length === 0) return;
    if (!engine || !ed) { pending.current.push(...sources); return; }
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
          const cur = store.getState().project ?? (await ed.project());
          const path = pathOf(s.file); // desktop: the file stays where it is, the project remembers its path
          const uri = s.handle ? `fs:${id}` : path ? `path:${path}` : `file:${s.file.name}:${s.file.size}`;
          if (s.handle) await saveHandle(uri, s.handle);
          const hash = await fingerprintFile(engine, s.file).catch(() => null); // 128 KiB read at most, however big the file
          const ref = mediaRef(id, s.file.name, uri, res.probed, hash);
          live.current.set(id, { file: s.file, probed: res.probed });
          // The very first import goes straight onto the timeline (every file of that drop, in order); one undo step per file.
          const first = cur.media.length === 0 && clipCount(cur) === 0;
          const ops = importOps(cur, ref, res.probed);
          if (first || added > 0) {
            const withRef: Project = { ...cur, media: [...cur.media, ref] };
            const place = insertOps(withRef, ref, res.probed, timelineEnd(cur));
            if (place) { ops.push(...place); added++; }
          }
          patch(id, { status: "ready", durationTicks: res.probed.durationTicks, width: res.probed.width, height: res.probed.height, codec: res.codec, poster: res.poster, hasAudio: res.probed.hasAudio, uri });
          await store.apply(ops);
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
  }, [engine, ed, store, enqueue, patch]);

  importRef.current = importSources;

  const addToTimeline = useCallback((id: string, start: number | "end" = "end"): Promise<boolean> => {
    if (!ed) return Promise.resolve(false);
    return enqueue(async () => {
      const ops = await timelineOps(store.getState().project ?? (await ed.project()), id, start);
      if (!ops) return false;
      await store.apply(ops);
      return true;
    });
  }, [ed, store, enqueue, timelineOps]);

  const remove = useCallback((id: string) => {
    setItems((all) => {
      const gone = all.find((i) => i.id === id);
      if (gone?.poster) { URL.revokeObjectURL(gone.poster); posters.current.delete(gone.poster); }
      return all.filter((i) => i.id !== id);
    });
  }, []);

  /**
   * Reconnects a file whose bytes are not available (reopened project, revoked permission): the stored handle (asks for permission), or the
   * `source` the user picked. It must be the same file (fingerprint, else size). A moved file's new location is recorded with `set_media`.
   */
  const relink = useCallback(async (id: string, source?: Source): Promise<boolean> => {
    const ref = store.getState().project?.media.find((m) => m.id === id);
    if (!ref || !engine || !ed) return false;
    const file = source?.file ?? (await loadHandle(ref.uri, true));
    if (!file) return false;
    const same = ref.hash ? (fingerprintSize(ref.hash) === file.size && (await fingerprintFile(engine, file)) === ref.hash) : file.name === ref.name;
    if (!same) return false;
    const probed = (await probeFile(engine, file, ref.kind)).probed;
    live.current.set(id, { file, probed });
    if (source?.handle) {
      const uri = `fs:${id}`;
      await saveHandle(uri, source.handle);
      if (uri !== ref.uri) await enqueue(() => store.apply({ op: "set_media", media: id, uri, hash: ref.hash ?? null }));
    }
    patch(id, { status: "ready", size: file.size });
    return true;
  }, [engine, ed, store, enqueue, patch]);

  /** The file behind a media item (for the preview's decoders), or null while it is offline. */
  const fileOf = useCallback(async (id: string): Promise<File | null> => {
    const ref = store.getState().project?.media.find((m) => m.id === id);
    return ref ? (await fileFor(id, ref.uri, ref.kind))?.file ?? null : null;
  }, [store, fileFor]);

  return { items, importSources, addToTimeline, remove, relink, fileOf };
}
