import { acquireProjectLock, newProject, openProjectSession, openProjectStorage, type Engine, type ProjectSession, type RecoveryNote, type SaveStatus } from "@app/engine-client";
import { useEffect, useState } from "react";
import { useI18n } from "./i18n";

/** One project for now ("default"); the project list arrives with M1-034. */
const PROJECT_ID = "default";

type Hook = { session: ProjectSession; kill(): void; storageKind: string };

/**
 * Opens (or recovers) the project and keeps it saved: every edit is in durable storage right after it is made, a crash is repaired on the next
 * open (`docs/features/persistence.md`). Fails soft: when storage is unavailable the editor still works and says so.
 */
export function usePersistence(engine: Engine | null) {
  const [recovered, setRecovered] = useState<RecoveryNote | null>(null);
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [problem, setProblem] = useState<string | null>(null);
  const [session, setSession] = useState<ProjectSession | null>(null);

  useEffect(() => {
    if (!engine) return;
    let alive = true;
    let release: (() => void) | undefined;
    let current: ProjectSession | undefined;
    let terminate: (() => void) | undefined;
    const e2e = new URLSearchParams(location.search).has("e2e"); // test hook: exposes the session as window.__overcut
    void (async () => {
      try {
        release = await acquireProjectLock(PROJECT_ID);
        if (!alive) return release(); // effect already torn down (React strict mode in dev)
        const storage = await openProjectStorage(PROJECT_ID);
        terminate = storage.terminate;
        if (!alive) return terminate?.();
        const opened = await openProjectSession(engine, storage, {
          createProject: () => {
            const p = newProject("Untitled project");
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
        setSession(opened.session);
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
      void current?.close().catch(() => undefined).finally(() => release?.());
      if (!current) release?.();
    };
  }, [engine]);

  const undoRecovery = async () => {
    try {
      await session?.undoRecovery();
      setRecovered(null);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    }
  };
  return { recovered, status, problem, undoRecovery, dismiss: () => setRecovered(null) };
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
