import type { ProjectEntry } from "@app/engine-client";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "./i18n";
import { Icon } from "./icons";
import { ConfirmDialog, Modal } from "./ProjectDialogs";
import { shapeBox, whenLabel } from "./projectsView";

export type HomeProps = {
  /** `null` while the list is loading. */
  entries: ProjectEntry[] | null;
  /** The project that was open last, listed first in the keyboard order and marked. */
  current: string | null;
  busy: boolean;
  onOpen(entry: ProjectEntry): void;
  onNew(): void;
  onOpenFile(): void;
  onRename(entry: ProjectEntry, name: string): void;
  onDuplicate(entry: ProjectEntry): void;
  onDelete(entry: ProjectEntry): void;
};

/** Rename: one text field, Enter applies, Esc cancels. An empty name goes back to the default name. */
function RenameDialog({ shown, onApply, onClose }: { shown: string; onApply(name: string): void; onClose(): void }) {
  const { t } = useI18n();
  const [value, setValue] = useState(shown);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.select(); }, []);
  return (
    <Modal title={t("projects.rename.title")} titleId="rename-title" testId="rename-dialog" onClose={onClose}>
      <form className="export-fields" onSubmit={(e) => { e.preventDefault(); onApply(value.trim() === t("app.untitled") ? "" : value.trim()); }}>
        <label>{t("projects.rename.label")}
          <input ref={input} value={value} maxLength={60} onChange={(e) => setValue(e.target.value)} spellCheck={false} data-testid="rename-input" />
        </label>
        <div className="export-actions">
          <button type="button" className="export-secondary" onClick={onClose} data-testid="rename-cancel">{t("canvas.cancel")}</button>
          <button type="submit" className="export-go" data-testid="rename-ok">{t("projects.rename.apply")}</button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * The projects list (PM-06): every project on this device with its real facts (name, last edit, canvas, clip count). No thumbnails: the
 * preview frame of a project that is not open would have to be rendered, so the card draws only its canvas shape. Phone: one column of
 * cards; wide screens: a grid. Every action is a visible button (no hover-only controls).
 */
export function Home({ entries, current, busy, onOpen, onNew, onOpenFile, onRename, onDuplicate, onDelete }: HomeProps) {
  const { t, locale } = useI18n();
  const [renaming, setRenaming] = useState<ProjectEntry | null>(null);
  const [deleting, setDeleting] = useState<ProjectEntry | null>(null);
  const now = Date.now();
  const nameOf = (e: ProjectEntry) => e.name || t("app.untitled");
  return (
    <div className="home" data-testid="projects-home">
      <header className="home-head">
        <div className="brand"><span className="logo" aria-hidden="true"><Icon name="split" size={16} /></span><strong>{t("app.name")}</strong></div>
        <h1>{t("projects.title")}</h1>
        <div className="home-actions">
          <button className="export-secondary" onClick={onOpenFile} disabled={busy} data-testid="projects-open-file"><Icon name="upload" size={18} />{t("projects.openFile")}</button>
          <button className="export-go" onClick={onNew} disabled={busy} data-testid="projects-new"><Icon name="plus" size={18} />{t("projects.new")}</button>
        </div>
      </header>
      <main className="home-body">
        {entries === null && <p className="export-note" role="status">{t("projects.loading")}</p>}
        {entries?.length === 0 && (
          <div className="empty" data-testid="projects-empty">
            <span className="empty-icon"><Icon name="film" size={26} /></span>
            <strong>{t("projects.empty.title")}</strong>
            <p>{t("projects.empty.text")}</p>
          </div>
        )}
        {entries && entries.length > 0 && (
          <ul className="project-list" aria-label={t("projects.list")}>
            {entries.map((e) => {
              const box = shapeBox(e.width, e.height);
              const facts = [e.width && e.height ? `${e.width} × ${e.height}` : null, e.clips !== undefined ? t("projects.clips", { count: e.clips }) : null].filter(Boolean).join(" · ");
              return (
                <li key={e.id} className="project-card" data-testid="project-card" data-id={e.id} data-current={e.id === current}>
                  <button className="project-open" onClick={() => onOpen(e)} disabled={busy} data-testid="project-open" aria-label={t("projects.open", { name: nameOf(e) })}>
                    <span className="project-shape" aria-hidden="true"><span style={{ inlineSize: box.w, blockSize: box.h }} /></span>
                    <span className="project-text">
                      <strong data-testid="project-name">{nameOf(e)}</strong>
                      <span>{t("projects.edited", { when: whenLabel(e.modified, now, locale, t("projects.justNow")) })}</span>
                      {facts && <span>{facts}</span>}
                    </span>
                  </button>
                  <div className="project-tools">
                    <button onClick={() => setRenaming(e)} disabled={busy} data-testid="project-rename" aria-label={t("projects.rename", { name: nameOf(e) })}><Icon name="pencil" size={18} /><span>{t("projects.rename.short")}</span></button>
                    <button onClick={() => onDuplicate(e)} disabled={busy} data-testid="project-duplicate" aria-label={t("projects.duplicate", { name: nameOf(e) })}><Icon name="duplicate" size={18} /><span>{t("projects.duplicate.short")}</span></button>
                    <button onClick={() => setDeleting(e)} disabled={busy} data-testid="project-delete" aria-label={t("projects.delete", { name: nameOf(e) })}><Icon name="trash" size={18} /><span>{t("projects.delete.short")}</span></button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </main>
      {renaming && <RenameDialog shown={nameOf(renaming)} onClose={() => setRenaming(null)} onApply={(name) => { const e = renaming; setRenaming(null); onRename(e, name); }} />}
      {deleting && (
        <ConfirmDialog
          title={t("projects.delete.title", { name: nameOf(deleting) })}
          body={t("projects.delete.body")}
          confirm={t("projects.delete.confirm")}
          onClose={() => setDeleting(null)}
          onConfirm={() => { const e = deleting; setDeleting(null); onDelete(e); }}
        />
      )}
    </div>
  );
}
