import { acquireProjectLock, newProject, openProjectSession, openProjectStorage, type Engine, type ProjectSession, type RecoveryNote, type SaveStatus } from "@app/engine-client";
import { useEffect, useState, type ReactNode } from "react";
import { reportSaveStatus } from "./errorScreen/crash";
import { useI18n } from "./i18n";
import { longSampleProject, sampleProject } from "./timeline/fixture";

type Hook = { session: ProjectSession; kill(): void; storageKind: string };

/**
 * Opens (or recovers) the project and keeps it saved: every edit is in durable storage right after it is made, a crash is repaired on the next
 * open (`docs/features/persistence.md`). Fails soft: when storage is unavailable the editor still works and says so.
 */
export function usePersistence(engine: Engine | null, projectId: string | null) {
  const [recovered, setRecovered] = useState<RecoveryNote | null>(null);
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [problem, setProblem] = useState<string | null>(null);
  const [session, setSession] = useState<ProjectSession | null>(null);
  /** Bumps when the project is replaced under the UI (undo recovery), so views re-read it. */
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    setSession(null);
    setRecovered(null);
    setProblem(null);
    if (!engine || !projectId) return; // no project open (the projects list is showing)
    let alive = true;
    let release: (() => void) | undefined;
    let current: ProjectSession | undefined;
    let terminate: (() => void) | undefined;
    const e2e = new URLSearchParams(location.search).has("e2e"); // test hook: exposes the session as window.__overcut
    const sampleParam = new URLSearchParams(location.search).get("sample");
    const sample = sampleParam !== null; // `?sample=2h` is a two-hour project (zoom and overview tests)
    void (async () => {
      try {
        release = await acquireProjectLock(projectId);
        if (!alive) return release(); // effect already torn down (React strict mode in dev)
        const storage = await openProjectStorage(projectId);
        terminate = storage.terminate;
        if (!alive) return terminate?.();
        const opened = await openProjectSession(engine, storage, {
          createProject: () => {
            // A new project is empty: the first import fills it (M1-032). `?sample` (tests, demos) starts with sample clips instead.
            const p = sample ? { ...(sampleParam === "2h" ? longSampleProject() : sampleProject()), name: "Untitled project" } : newProject("Untitled project");
            if (e2e) p.media.push({ id: "00000000000000000000000000000e2e", kind: "video", name: "e2e.mp4", uri: "media/e2e.mp4", hash: null, duration: 600 * 705_600_000 });
            return p;
          },
          onStatus: (s, err) => {
            if (!alive) return;
            setStatus(s);
            reportSaveStatus(s);
            setProblem(err ? err.message : null);
          },
          onFirstProject: () => void navigator.storage?.persist?.().catch(() => undefined),
        });
        if (!alive) return void opened.session.close().finally(() => terminate?.());
        current = opened.session;
        setSession(opened.session);
        reportSaveStatus("saved");
        setRecovered(opened.recovered);
        if (e2e) (window as unknown as { __overcut: Hook }).__overcut = { session: opened.session, kill: () => terminate?.(), storageKind: storage.kind };
      } catch (err) {
        reportSaveStatus("error");
        if (alive) setProblem(err instanceof Error ? err.message : String(err));
      }
    })();
    // Best effort at a clean end: fold the log into the project. If the browser cuts this short the log is still durable and the next open recovers it.
    const leave = () => void current?.close().catch(() => undefined);
    addEventListener("pagehide", leave);
    return () => {
      alive = false;
      removeEventListener("pagehide", leave);
      void current?.close().catch(() => undefined).finally(() => { terminate?.(); release?.(); });
      if (!current) release?.();
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
  return { ready: session !== null, session, epoch, recovered, status, problem, undoRecovery, dismiss: () => setRecovered(null) };
}

/** Small, non-blocking notes: what was recovered (with an undo) and why saving is not working. */
export function PersistenceNotes({ state, extra }: { state: ReturnType<typeof usePersistence>; extra?: ReactNode }) {
  const { t } = useI18n();
  const { recovered, problem, undoRecovery, dismiss } = state;
  if (!recovered && !problem && !extra) return null;
  return (
    <div className="persist-notes">
      {extra}
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
