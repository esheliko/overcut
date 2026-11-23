import { useCallback, useEffect, useState } from "react";
import type { VersionMeta, VersionStore } from "@app/engine-client";
import { useI18n } from "../i18n";
import { formatBytes } from "../media/plan";
import { Sheet } from "./Sheet";

/** PM-06: named snapshots and the automatic ones (every 10 minutes of editing, the last 20). Restoring is one undoable edit: nothing is lost. */
export function VersionsSheet({ versions, onSave, onRestore, onClose }: { versions: VersionStore; onSave(name: string): Promise<void>; onRestore(id: string): Promise<void>; onClose(): void }) {
  const { t, locale } = useI18n();
  const [list, setList] = useState<VersionMeta[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const reload = useCallback(() => void versions.list().then(setList, () => setList([])), [versions]);
  useEffect(reload, [reload]);
  const when = (at: number) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(at);
  const run = async (job: () => Promise<void>) => {
    setBusy(true);
    setFailed(false);
    try { await job(); } catch { setFailed(true); }
    setBusy(false);
    reload();
  };
  return (
    <Sheet title={t("versions.title")} onClose={onClose} testid="versions">
      <form className="version-new" onSubmit={(e) => { e.preventDefault(); void run(async () => { await onSave(name.trim()); setName(""); }); }}>
        <input value={name} maxLength={60} placeholder={t("versions.namePlaceholder")} aria-label={t("versions.name")} onChange={(e) => setName(e.target.value)} data-testid="version-name" spellCheck={false} />
        <button className="primary" type="submit" disabled={busy} data-testid="version-save">{t("versions.save")}</button>
      </form>
      {failed && <p className="export-error" role="alert">{t("versions.failed")}</p>}
      <p className="export-note">{t("versions.hint")}</p>
      {list && list.length === 0 && <p className="export-note" data-testid="versions-empty">{t("versions.empty")}</p>}
      <ul className="version-list" data-testid="version-list">
        {(list ?? []).map((v) => (
          <li key={v.id} className="version-row" data-auto={v.auto}>
            <div>
              <strong>{v.name ?? t("versions.auto")}</strong>
              <span>{when(v.at)} · {formatBytes(v.size)}</span>
            </div>
            <button className="chip-btn" disabled={busy} onClick={() => void run(() => onRestore(v.id))} data-testid="version-restore">{t("versions.restore")}</button>
            {!v.auto && <button className="chip-btn" disabled={busy} onClick={() => void run(() => versions.remove(v.id))}>{t("versions.delete")}</button>}
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
