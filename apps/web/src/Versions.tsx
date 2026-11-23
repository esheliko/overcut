import type { ProjectSession, SnapshotInfo, SnapshotKind } from "@app/engine-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "./i18n";
import { Icon } from "./icons";
import { Modal } from "./ProjectDialogs";
import { formatBytes } from "./media/plan";

/** Automatic snapshot: at most one per this much editing time, and only when the project changed since the last one. */
export const AUTO_SNAPSHOT_MS = 5 * 60_000;
const CHECK_MS = 30_000;

/** Takes the automatic snapshots (PM-06). Fails soft: a snapshot that cannot be written is skipped, editing and autosave carry on. */
export function useAutoSnapshots(session: ProjectSession | null) {
  const seen = useRef(-1);
  const last = useRef(Date.now());
  useEffect(() => {
    if (!session) return;
    seen.current = session.stats.appends;
    last.current = Date.now();
    const id = setInterval(() => {
      if (session.stats.appends === seen.current || Date.now() - last.current < AUTO_SNAPSHOT_MS) return;
      seen.current = session.stats.appends;
      last.current = Date.now();
      void session.exportBytes().then((b) => session.snapshots.add("auto", "", b)).catch(() => undefined);
    }, CHECK_MS);
    return () => clearInterval(id);
  }, [session]);
}

const KIND_KEY: Record<SnapshotKind, string> = {
  manual: "versions.kind.manual",
  auto: "versions.kind.auto",
  "before-open": "versions.kind.beforeOpen",
  "before-new": "versions.kind.beforeNew",
  "before-restore": "versions.kind.beforeRestore",
};

/** App menu > Versions: save a named snapshot, restore one (the current project is snapshotted first, so a restore can be undone from here), delete. */
export function VersionsDialog({ session, onRestore, onClose }: { session: ProjectSession; onRestore(id: string, label: string): Promise<void>; onClose(): void }) {
  const { t } = useI18n();
  const [items, setItems] = useState<SnapshotInfo[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const reload = useCallback(() => session.snapshots.list().then(setItems, () => setItems([])), [session]);
  useEffect(() => { void reload(); }, [reload]);
  const run = async (job: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    try { await job(); await reload(); } catch (e) { setProblem(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const save = () => run(async () => {
    await session.snapshots.add("manual", name || t("versions.defaultName"), await session.exportBytes());
    setName("");
  });
  const total = (items ?? []).reduce((n, s) => n + s.bytes, 0);
  const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return (
    <Modal title={t("versions.title")} titleId="versions-title" testId="versions-dialog" onClose={onClose}>
      <p className="export-note">{t("versions.intro", { max: 20 })}</p>
      <form className="versions-save" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label>{t("versions.name")}
          <input value={name} maxLength={80} placeholder={t("versions.defaultName")} onChange={(e) => setName(e.target.value)} data-testid="versions-name" />
        </label>
        <button type="submit" className="export-go" disabled={busy} data-testid="versions-save">{t("versions.save")}</button>
      </form>
      {problem && <p className="export-note" role="alert">{problem}</p>}
      {items && items.length === 0 && <p className="export-note" data-testid="versions-empty">{t("versions.empty")}</p>}
      {items && items.length > 0 && (
        <>
          <ul className="versions-list" aria-label={t("versions.list")} data-testid="versions-list">
            {items.map((s) => (
              <li key={s.id} data-testid="version-item" data-kind={s.kind}>
                <span className="versions-text">
                  <strong>{s.label || t(KIND_KEY[s.kind])}</strong>
                  <span>{s.label ? `${t(KIND_KEY[s.kind])} · ` : ""}{when(s.at)} · {formatBytes(s.bytes)}</span>
                </span>
                <button className="export-secondary versions-act" disabled={busy} onClick={() => void run(async () => { await onRestore(s.id, s.label || t(KIND_KEY[s.kind])); onClose(); })} data-testid="version-restore">{t("versions.restore")}</button>
                <button className="icon-btn versions-act" disabled={busy} aria-label={t("versions.delete", { name: s.label || when(s.at) })} onClick={() => void run(() => session.snapshots.remove(s.id))} data-testid="version-delete"><Icon name="close" size={18} /></button>
              </li>
            ))}
          </ul>
          <p className="export-note" data-testid="versions-size">{t("versions.size", { count: items.length, size: formatBytes(total) })}</p>
        </>
      )}
    </Modal>
  );
}
