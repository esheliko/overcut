import { acquireProjectLock, newProject, openProjectSession, openProjectStorage, VersionStore, type Engine, type ProjectSession, type RecoveryNote, type Resolution, type Rational, type SaveStatus } from "@app/engine-client";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "./i18n";
import { sampleProject } from "./timeline/fixture";

/** What a project made by "New project" starts with. Registered by id before it opens; a project that is not in here (the legacy one, a recovered one) starts as the default. */
export interface NewSpec {
  name: string;
  size: Resolution | null;
  rate: Rational | null;
}
export const NEW_SPECS = new Map<string, NewSpec>();

type Hook = { session: ProjectSession; kill(): void; storageKind: string };

/**
 * Opens (or recovers) the project and keeps it saved: every edit is in durable storage right after it is made, a crash is repaired on the next
 * open (`docs/features/persistence.md`). Fails soft: when storage is unavailable the editor still works and says so.
 */
export function usePersistence(engine: Engine | null, projectId: string | null) {
  const [recovered, setRecovered] = useState<RecoveryNote | null>(null);
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [problem, setProblem] = useState<string | null>(null);
  const [live, setLive] = useState<{ id: string; session: ProjectSession; versions: VersionStore } | null>(null);
  /** Only the session of the project that is asked for: for a render after a switch the previous one is already closing and must not be used. */
  const mine = live && live.id === projectId ? live : null;
  const session = mine?.session ?? null;
  const versions = mine?.versions ?? null;
  /** Bumps when the project is replaced under the UI (undo recovery), so views re-read it. */
  const [epoch, setEpoch] = useState(0);
  /** The previous project's clean close: the next one must not open (and take over the engine's one editor) before it finished. */
  const closing = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    if (!engine || !projectId) return;
    let alive = true;
    let release: (() => void) | undefined;
    let current: ProjectSession | undefined;
    let terminate: (() => void) | undefined;
    const e2e = new URLSearchParams(location.search).has("e2e"); // test hook: exposes the session as window.__overcut
    const sample = new URLSearchParams(location.search).has("sample");
    void (async () => {
      try {
        await closing.current;
        if (!alive) return;
        release = await acquireProjectLock(projectId);
        if (!alive) return release(); // effect already torn down (React strict mode in dev)
        const storage = await openProjectStorage(projectId);
        terminate = storage.terminate;
        if (!alive) return terminate?.();
        const opened = await openProjectSession(engine, storage, {
          createProject: () => {
            // A new project is empty: the first import fills it (M1-032). `?sample` (tests, demos) starts with sample clips instead.
            const spec = NEW_SPECS.get(projectId);
            const p = sample ? { ...sampleProject(), name: "Untitled project" } : newProject(spec?.name ?? "Untitled project");
            const seq = p.sequences[0];
            if (seq && spec?.size) seq.resolution = spec.size;
            if (seq && spec?.rate) seq.frame_rate = spec.rate;
            if (e2e) p.media.push({ id: "00000000000000000000000000000e2e", kind: "video", name: "e2e.mp4", uri: "media/e2e.mp4", hash: null, duration: 600 * 705_600_000 });
            return p;
          },
          onStatus: (s, err) => {
            if (!alive) return;
            setStatus(s);
            setProblem(err ? err.message : null);
          },
          onFirstProject: () => void navigator.storage?.persist?.().catch(() => undefined),
        });
        if (!alive) return void opened.session.close().finally(() => terminate?.());
        current = opened.session;
        setLive({ id: projectId, session: opened.session, versions: new VersionStore(storage) });
        setRecovered(opened.recovered);
        if (e2e) (window as unknown as { __overcut: Hook }).__overcut = { session: opened.session, kill: () => terminate?.(), storageKind: storage.kind };
      } catch (err) {
        if (alive) setProblem(err instanceof Error ? err.message : String(err));
      }
    })();
    // Best effort at a clean end: fold the log into the project. If the browser cuts this short the log is still durable and the next open recovers it.
    const leave = () => void current?.close().catch(() => undefined);
    addEventListener("pagehide", leave);
    return () => {
      alive = false;
      removeEventListener("pagehide", leave);
      setLive(null);
      setRecovered(null);
      setProblem(null);
      setStatus("saved");
      closing.current = (current ? current.close().catch(() => undefined) : Promise.resolve()).finally(() => { release?.(); terminate?.(); });
    };
  }, [engine, projectId]);

  const undoRecovery = async () => {
    try {
      await session?.undoRecovery();
      setEpoch((n) => n + 1);
      setRecovered(null);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    }
  };
  return { ready: session !== null, session, versions, epoch, recovered, status, problem, undoRecovery, dismiss: () => setRecovered(null) };
}

/** Small, non-blocking notes: what was recovered (with an undo) and why saving is not working. */
export function PersistenceNotes({ state }: { state: ReturnType<typeof usePersistence> }) {
  const { t } = useI18n();
  const { recovered, problem, undoRecovery, dismiss } = state;
  if (!recovered && !problem) return null;
  return (
    <div className="persist-notes">
      {problem && <div className="persist-note danger" role="alert" data-testid="save-problem">{problem}</div>}
      {recovered && (
        <div className="persist-note" role="status" data-testid="recovery-note">
          <span>{t("persist.recovered")}</span>
          <button onClick={() => void undoRecovery()}>{t("persist.undo-recovery")}</button>
          <button className="icon-btn" aria-label={t("persist.dismiss")} onClick={dismiss}>×</button>
        </div>
      )}
    </div>
  );
}
