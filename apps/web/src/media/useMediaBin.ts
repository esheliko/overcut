import { MediaDecodeError, fingerprintFile, fingerprintSize, newProject, type Editing, type Engine, type MediaKind, type Op, type Project } from "@app/engine-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { probeFile } from "./probe";
import { TICKS, classify, landingStart, pictureEnd, sentence, clipCount, extOf, importOps, insertOps, mediaRef, newId, type Probed } from "./plan";
import { allowAll, handleState, loadHandle, pathOf, saveHandle, type Source } from "./sources";
import { askPersistent, canKeep, keepCopy, keptSupported } from "./kept";
import { loadPoster, savePoster } from "./posterCache";
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
  /** Offline, but the browser still holds the file's handle: it only needs the person's permission ("Allow access"), the file is not missing. */
  needsPermission?: boolean;
  /** While a copy of the file is being saved on this device (0..1, only shown for big files); undefined otherwise. */
  keeping?: number;
  /** For an `unsupported` card: the engine's own sentence, behind "Details" (the card itself keeps two short lines). */
  details?: string;
}

/** Strings the hook needs (the UI passes `t`-built text so this file stays free of i18n). */
export interface BinText {
  notMedia: (name: string) => string;
  /** Codec or container the device cannot decode. `detail` is the engine's own sentence. */
  unsupported: (name: string, ext: string, detail: string) => string;
  failed: (name: string, ext: string) => string;
  imported: (count: number) => string;
  /** What Undo / Redo call the import step of this file ("import of clip.mp4"). */
  importLabel: (name: string) => string;
  announce: (message: string) => void;
  /** A file that was refused, shown where the person can see it (the Media sheet may have closed on a phone). */
  refused?: (message: string) => void;
  /** An import finished: what came in, and whether it was put on the timeline (else it is only in the bin and the person is told how to add it). */
  result?: (r: { ids: string[]; names: string[]; placed: boolean; /** The imported items that are only in the bin (a video imported into a project that already has clips). */ binOnly: string[] }) => void;
}

/** Where an import goes. `place`: onto the timeline as well (a drop on the timeline); otherwise it lands there only when the timeline is empty. */
export interface ImportOptions { place?: boolean }

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
  const importRef = useRef<(s: Source[], o?: ImportOptions) => Promise<void>>(() => Promise.resolve());
  /** Offline media the browser can reopen once the person allows it (see `allowAccess`). */
  const permission = useRef(new Set<string>());
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
    // Posters come back from the device's poster cache at once, before any file is read or any permission asked.
    for (const m of p.media) {
      void loadPoster(m).then((url) => {
        if (!url) return;
        posters.current.add(url);
        let used = false;
        setItems((all) => all.map((i) => { if (i.id !== m.id || i.poster) return i; used = true; return { ...i, poster: url }; }));
        if (!used) { URL.revokeObjectURL(url); posters.current.delete(url); }
      });
    }
    // A reopened project: files whose stored handle still has permission come back by themselves; the rest show "Relink".
    for (const m of p.media) {
      if (live.current.has(m.id)) continue;
      // Another project opened in this window: a file already open under the same name (and the size the fingerprint records) is the same file.
      const same = [...live.current.values()].find((l) => l.file.name === m.name && (!m.hash || fingerprintSize(m.hash) === l.file.size));
      if (same) {
        live.current.set(m.id, same);
        setItems((all) => all.map((i) => (i.id === m.id && i.status === "offline" ? { ...i, status: "ready", size: same.file.size } : i)));
        continue;
      }
      const state = await handleState(m.uri);
      if (state === "prompt") { permission.current.add(m.id); setItems((all) => all.map((i) => (i.id === m.id && i.status === "offline" ? { ...i, needsPermission: true } : i))); continue; }
      const file = state === "granted" ? await loadHandle(m.uri, false, m.name) : null;
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
  const fileFor = useCallback(async (id: string, uri: string, kind: MediaKind, name?: string): Promise<Live | null> => {
    const have = live.current.get(id);
    if (have) return have;
    const file = await loadHandle(uri, false, name);
    if (!file || !engine) return null;
    const l = { file, probed: (await probeFile(engine, file, kind)).probed };
    live.current.set(id, l);
    return l;
  }, [engine]);

  /** The playhead in ticks (the store keeps frames). */
  const playheadTicks = useCallback((cur: Project): number => {
    const r = cur.sequences[0]?.frame_rate ?? { num: 30, den: 1 };
    return Math.round((store.getState().playhead * TICKS * r.den) / r.num);
  }, [store]);

  /** Ops for putting a media item on the timeline by the one landing rule (`landingStart`): a picture after the last picture on V1, sound at `start` or the playhead. */
  const timelineOps = useCallback(async (cur: Project, id: string, start?: number, track?: string): Promise<Op[] | null> => {
    const ref = cur.media.find((m) => m.id === id);
    const l = ref && (await fileFor(id, ref.uri, ref.kind, ref.name));
    if (!ref || !l) return null;
    return insertOps(cur, ref, l.probed, landingStart(cur, ref, { start, playhead: playheadTicks(cur), track }), undefined, track);
  }, [fileFor, playheadTicks]);

  const importSources = useCallback(async (sources: Source[], opts?: ImportOptions): Promise<void> => {
    if (sources.length === 0) return;
    if (!engine || !ed) { pending.current.push(...sources); return; }
    const t = textRef.current;
    // Show every card at once, probe them one after another so the first import is deterministic.
    const rows = sources.map((s) => ({ s, kind: classify(s.file.name, s.file.type), id: newId() }));
    for (const r of rows) if (!r.kind) t.refused?.(t.notMedia(r.s.file.name));
    setItems((all) => [
      ...rows.map<BinItem>((r) => r.kind
        ? { id: r.id, name: r.s.file.name, kind: r.kind, size: r.s.file.size, status: "probing" }
        : { id: r.id, name: r.s.file.name, kind: "video", size: r.s.file.size, status: "unsupported", message: t.notMedia(r.s.file.name) }),
      ...all,
    ]);
    // One rule everywhere: a file always lands in the bin. Pictures also go on the timeline when it is empty or the person dropped them there; sound-only files
    // (music) go on the timeline too when the project already has clips ("add music" is the headline task, FIRST-1). Where: `landingStart`.
    const startProject = store.getState().project ?? (await ed.project());
    const emptyTimeline = clipCount(startProject) === 0;
    const place = !!opts?.place || emptyTimeline;
    // Pictures of a batch go one after another at the end of V1 (sound never moves that point); sound-only files start with the batch, under its pictures,
    // or at the playhead when the batch has no picture that goes on the timeline (UX r16).
    const batchStart = place && rows.some((r) => r.kind && r.kind !== "audio") ? pictureEnd(startProject) : playheadTicks(startProject);
    const ids: string[] = [];
    const names: string[] = [];
    let placed = false;
    const binOnly: string[] = [];
    let imported = 0;
    let refused = rows.filter((r) => !r.kind).length;
    for (const r of rows) {
      if (!r.kind) continue;
      const { s, id, kind } = r;
      await enqueue(async () => {
        try {
          const res = await probeFile(engine, s.file, kind);
          if (res.poster) posters.current.add(res.poster);
          const cur = store.getState().project ?? (await ed.project());
          const path = pathOf(s.file); // desktop: the file stays where it is, the project remembers its path
          // No handle to keep (Safari, Firefox, phones): keep a copy on the device when there is room, so a reload finds the file without a relink.
          const keep = !s.handle && !path && keptSupported() && (await canKeep(s.file.size));
          const uri = s.handle ? `fs:${id}` : path ? `path:${path}` : keep ? `kept:${id}` : `file:${s.file.name}:${s.file.size}`;
          if (s.handle) await saveHandle(uri, s.handle);
          const hash = await fingerprintFile(engine, s.file).catch(() => null); // 128 KiB read at most, however big the file
          const ref = mediaRef(id, s.file.name, uri, res.probed, hash);
          live.current.set(id, { file: s.file, probed: res.probed });
          if (res.posterBlob) void savePoster(ref, res.posterBlob);
          // Every file of a drop onto an empty timeline (or onto the timeline) goes there in order; one undo step per file.
          const ops = importOps(cur, ref, res.probed);
          const here = place || ref.kind === "audio";
          if (here) {
            const withRef: Project = { ...cur, media: [...cur.media, ref] };
            const put = insertOps(withRef, ref, res.probed, ref.kind === "audio" ? batchStart : landingStart(withRef, ref, { playhead: batchStart }));
            if (put) { ops.push(...put); placed = true; }
            else binOnly.push(id);
          } else binOnly.push(id);
          patch(id, { status: "ready", kind: res.probed.kind, durationTicks: res.probed.durationTicks, width: res.probed.width, height: res.probed.height, codec: res.codec, poster: res.poster, hasAudio: res.probed.hasAudio, uri });
          await store.apply(ops, undefined, t.importLabel(s.file.name));
          if (keep) {
            void askPersistent();
            // Saved in a Worker while editing goes on; a copy that cannot be finished (disk full) puts the old "choose the file again" locator back.
            patch(id, { keeping: 0 });
            void keepCopy(s.file, id, (p) => patch(id, { keeping: p })).then((ok) => {
              patch(id, { keeping: undefined });
              if (!ok) void enqueue(() => store.apply({ op: "set_media", media: id, uri: `file:${s.file.name}:${s.file.size}`, hash })).catch(() => undefined);
            });
          }
          imported++;
          ids.push(id);
          names.push(s.file.name);
        } catch (e) {
          const ext = extOf(s.file.name).toUpperCase();
          const unsupported = e instanceof MediaDecodeError && e.kind === "unsupported";
          const message = unsupported ? t.unsupported(s.file.name, ext, sentence(e.message)) : t.failed(s.file.name, ext);
          patch(id, { status: "unsupported", message, details: e instanceof Error ? sentence(e.message) : undefined });
          refused++;
          t.announce(message);
          t.refused?.(message);
        }
      });
    }
    // Only what really came in, and never over the top of a refusal: a refused file announced why, and a count would replace that for a screen reader.
    if (imported > 0 && refused === 0) t.announce(t.imported(imported));
    if (imported > 0) t.result?.({ ids, names, placed, binOnly: binOnly.filter((x) => ids.includes(x)) });
  }, [engine, ed, store, enqueue, patch]);

  importRef.current = importSources;

  const addToTimeline = useCallback((id: string, start?: number, track?: string): Promise<boolean> => {
    if (!ed) return Promise.resolve(false);
    return enqueue(async () => {
      const ops = await timelineOps(store.getState().project ?? (await ed.project()), id, start, track);
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
    permission.current.delete(id);
    patch(id, { status: "ready", size: file.size, needsPermission: false });
    return true;
  }, [engine, ed, store, enqueue, patch]);

  /**
   * "Allow access": the browser kept every file's handle but asks again after a reload. One click asks for all of them at once (every prompt starts
   * inside this click, before any await), then the granted files come back ready. Resolves to how many came back and how many were waiting.
   */
  const allowAccess = useCallback((): Promise<{ done: number; total: number }> => {
    const refs = (store.getState().project?.media ?? []).filter((m) => permission.current.has(m.id));
    const asked = allowAll(refs.map((m) => m.uri));
    return asked.then(async (granted) => {
      let done = 0;
      for (const m of refs) {
        if (!granted.includes(m.uri)) continue;
        const file = await loadHandle(m.uri);
        if (!file) continue;
        permission.current.delete(m.id);
        patch(m.id, { status: "ready", size: file.size, needsPermission: false });
        done++;
      }
      return { done, total: refs.length };
    });
  }, [store, patch]);

  /**
   * A reopened project's offline media, matched to the files the person picked by name (and size, from the fingerprint); each match is verified like
   * a single relink. Returns how many came back.
   */
  const relinkMany = useCallback(async (sources: Source[]): Promise<number> => {
    let n = 0;
    for (const ref of store.getState().project?.media ?? []) {
      if (live.current.has(ref.id)) continue;
      const size = fingerprintSize(ref.hash ?? "");
      const match = sources.find((s) => s.file.name.toLowerCase() === ref.name.toLowerCase() && (size === null || size === s.file.size));
      if (match && (await relink(ref.id, match).catch(() => false))) n += 1;
    }
    return n;
  }, [store, relink]);

  /** The file behind a media item (for the preview's decoders), or null while it is offline. */
  const fileOf = useCallback(async (id: string): Promise<File | null> => {
    const ref = store.getState().project?.media.find((m) => m.id === id);
    return ref ? (await fileFor(id, ref.uri, ref.kind, ref.name))?.file ?? null : null;
  }, [store, fileFor]);

  /** Ids of the media whose file is readable now (ready cards), as a stable string: consumers re-request derived data when it changes. */
  const readyIds = items.filter((i) => i.status === "ready").map((i) => i.id).sort().join(",");
  return { items, readyIds, importSources, addToTimeline, remove, relink, relinkMany, allowAccess, fileOf };
}
