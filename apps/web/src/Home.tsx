import type { ProjectEntry } from "@app/engine-client";
import { useCallback, useEffect, useRef, useState } from "react";
import "./home-library.css";
import { useI18n } from "./i18n";
import { Icon } from "./icons";
import { ConfirmDialog, Modal } from "./ProjectDialogs";
import { ProjectMenu, type MenuItem } from "./ProjectMenu";
import { formatDuration } from "./media/plan";
import { validPoster } from "./posterSource";
import { isArchived, libraryView, whenLabel, type LibraryFilter } from "./projectsView";

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
  /** Archive (`true`) or restore (`false`): only the row changes. */
  onArchive(entry: ProjectEntry, archived: boolean): void;
  /** Save the project as a `.overcut` file. */
  onExport(entry: ProjectEntry): void;
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
 * The projects library (PM-06, PM-08): every project on this device with its real facts (name, last edit, canvas, length, clip count) and a small
 * poster (the frame at the playhead, saved with the project's row when it is left; a placeholder tinted with the first track colour until then).
 * Responsive grid of 16:9 poster cards, newest edit first, "New project" as the first tile. Per-project actions live in the card's "…" menu (a real button: touch, keyboard and mouse alike).
 * Archive hides a project from the main list without deleting it ("Archived" filter, Restore); Delete asks first.
 */
export function Home({ entries, current, busy, onOpen, onNew, onOpenFile, onRename, onDuplicate, onArchive, onExport, onDelete }: HomeProps) {
  const { t, locale } = useI18n();
  const [renaming, setRenaming] = useState<ProjectEntry | null>(null);
  const [deleting, setDeleting] = useState<ProjectEntry | null>(null);
  const [menu, setMenu] = useState<{ entry: ProjectEntry; anchor: DOMRect } | null>(null);
  const [filter, setFilter] = useState<LibraryFilter>("active");
  const [note, setNote] = useState<{ text: string; undo?: () => void } | null>(null);
  const now = Date.now();
  const nameOf = (e: ProjectEntry) => e.name || t("app.untitled");
  const closeMenu = useCallback(() => setMenu(null), []);
  const view = libraryView(entries ?? [], filter);
  // The note (with Undo) goes away by itself; a new one restarts the clock.
  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 8000);
    return () => clearTimeout(id);
  }, [note]);

  const archive = (e: ProjectEntry, archived: boolean) => {
    onArchive(e, archived);
    setNote({ text: t(archived ? "projects.archived" : "projects.restored", { name: nameOf(e) }), undo: () => { setNote(null); onArchive(e, !archived); } });
  };
  const itemsFor = (e: ProjectEntry): MenuItem[] => [
    { id: "rename", label: t("projects.rename.short"), icon: "pencil", onPick: () => setRenaming(e) },
    { id: "duplicate", label: t("projects.duplicate.short"), icon: "duplicate", onPick: () => onDuplicate(e) },
    { id: "export", label: t("projects.export.short"), icon: "export", onPick: () => onExport(e) },
    isArchived(e)
      ? { id: "restore", label: t("projects.restore.short"), icon: "undo", onPick: () => archive(e, false) }
      : { id: "archive", label: t("projects.archive.short"), icon: "archive", onPick: () => archive(e, true) },
    { id: "delete", label: t("projects.delete.short"), icon: "trash", danger: true, onPick: () => setDeleting(e) },
  ];

  return (
    <div className="home" data-testid="projects-home">
      <header className="home-head">
        <div className="brand"><span className="logo" aria-hidden="true"><Icon name="split" size={16} /></span><strong>{t("app.name")}</strong></div>
        <div className="home-actions">
          <button className="export-secondary" onClick={onOpenFile} disabled={busy} title={t("projects.openFile.hint")} data-testid="projects-open-file"><Icon name="upload" size={18} />{t("projects.openFile")}</button>
          <button className="export-go" onClick={onNew} disabled={busy} data-testid="projects-new"><Icon name="plus" size={18} />{t("projects.new")}</button>
        </div>
      </header>
      <main className="home-body">
        <div className="home-title">
          <h1>{t("projects.title")}</h1>
          {entries && entries.length > 0 && <span className="home-count" data-testid="projects-count">{view.active}</span>}
        </div>
        {entries === null && <p className="export-note" role="status">{t("projects.loading")}</p>}
        {entries?.length === 0 && (
          <div className="empty home-empty" data-testid="projects-empty">
            <strong>{t("projects.empty.title")}</strong>
            <p>{t("projects.empty.text")}</p>
            <div className="lib-empty-actions">
              <button className="export-go" onClick={onNew} disabled={busy} data-testid="projects-empty-new"><Icon name="plus" size={18} />{t("projects.new")}</button>
            </div>
          </div>
        )}
        {entries && entries.length > 0 && (view.archived > 0 || filter === "archived") && (
          <div className="lib-filter" role="group" aria-label={t("projects.filter.label")}>
            <button aria-pressed={filter === "active"} onClick={() => setFilter("active")} data-testid="library-filter-active">{t("projects.filter.active", { count: view.active })}</button>
            <button aria-pressed={filter === "archived"} onClick={() => setFilter("archived")} data-testid="library-filter-archived">{t("projects.filter.archived", { count: view.archived })}</button>
          </div>
        )}
        {entries && entries.length > 0 && view.shown.length === 0 && (
          <div className="empty" data-testid={filter === "archived" ? "archived-empty" : "active-empty"}>
            <strong>{t(filter === "archived" ? "projects.emptyArchived.title" : "projects.allArchived.title")}</strong>
            <p>{t(filter === "archived" ? "projects.emptyArchived.text" : "projects.allArchived.text")}</p>
            <div className="lib-empty-actions">
              {filter === "archived"
                ? <button className="export-secondary" onClick={() => setFilter("active")}>{t("projects.showActive")}</button>
                : <button className="export-secondary" onClick={() => setFilter("archived")}>{t("projects.showArchived")}</button>}
            </div>
          </div>
        )}
        {view.shown.length > 0 && (
          <ul className="project-list" aria-label={t(filter === "archived" ? "projects.list.archived" : "projects.list")}>
            {filter === "active" && (
              <li className="project-new-tile">
                <button onClick={onNew} disabled={busy} data-testid="projects-new-tile" aria-label={t("projects.new")}>
                  <span className="tile-plus" aria-hidden="true"><Icon name="plus" size={22} /></span>
                  <span>{t("projects.new")}</span>
                </button>
              </li>
            )}
            {[...view.shown].sort((x, y) => y.modified - x.modified).map((e) => {
              const archived = isArchived(e);
              const isCurrent = e.id === current && !archived;
              const facts = [
                e.width && e.height ? `${e.width} × ${e.height}` : null,
                e.ticks ? formatDuration(e.ticks) : null,
                e.clips !== undefined ? t("projects.clips", { count: e.clips }) : null,
              ].filter(Boolean).join(" · ");
              return (
                <li key={e.id} className="project-card lib-card" data-testid="project-card" data-id={e.id} data-current={e.id === current} data-archived={archived}>
                  <button className="project-open" onClick={() => onOpen(e)} disabled={busy} data-testid="project-open" aria-label={t("projects.open", { name: nameOf(e) })}>
                    <span className="poster" aria-hidden="true" data-poster={validPoster(e.poster)} style={e.colour ? ({ ["--tint" as string]: e.colour }) : undefined}>
                      {validPoster(e.poster)
                        ? <img src={e.poster} alt="" width={320} height={180} decoding="async" loading="lazy" draggable={false} />
                        : <span className="poster-empty"><Icon name="film" size={28} /></span>}
                    </span>
                    <span className="project-text">
                      <strong data-testid="project-name">{nameOf(e)}</strong>
                      {facts && <span>{facts}</span>}
                      <span>{t("projects.edited", { when: whenLabel(e.modified, now, locale, t("projects.justNow")) })}</span>
                      {archived && <span data-testid="project-archived-label">{t("projects.archivedWhen", { when: whenLabel(e.archived!, now, locale, t("projects.justNow")) })}</span>}
                    </span>
                  </button>
                  {isCurrent && <span className="pill-open" data-testid="project-current">{t("projects.current")}</span>}
                  <button
                    className="lib-more"
                    disabled={busy}
                    aria-haspopup="menu"
                    aria-expanded={menu?.entry.id === e.id}
                    aria-label={t("projects.menu", { name: nameOf(e) })}
                    data-testid="project-more"
                    onClick={(ev) => setMenu(menu?.entry.id === e.id ? null : { entry: e, anchor: ev.currentTarget.getBoundingClientRect() })}
                  ><Icon name="more" size={20} /></button>
                </li>
              );
            })}
          </ul>
        )}
      </main>
      {menu && <ProjectMenu label={t("projects.menu", { name: nameOf(menu.entry) })} items={itemsFor(menu.entry)} anchor={menu.anchor} onClose={closeMenu} />}
      {note && (
        <div className="lib-note" role="status" data-testid="library-note">
          <span>{note.text}</span>
          {note.undo && <button onClick={note.undo} disabled={busy} data-testid="library-undo">{t("projects.undo")}</button>}
          <button onClick={() => setNote(null)} aria-label={t("projects.dismiss")}><Icon name="close" size={18} /></button>
        </div>
      )}
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
