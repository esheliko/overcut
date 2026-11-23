import { useCallback, useState } from "react";
import { type Engine, type ProjectLibrary, type ProjectMeta } from "@app/engine-client";
import { announce } from "../a11y/announcer";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { TICKS, formatDuration } from "../media/plan";
import { deleteProject, deliverProjectFile, duplicateProject, importProject, pickProjectFile, projectBytes } from "./actions";
import { Sheet } from "./Sheet";

interface Props {
  engine: Engine | null;
  library: ProjectLibrary;
  onOpen(id: string): void;
  onNew(): void;
}

/** PM-07: the Projects home. Shown when no project is open and from the menu. Autosave is the norm: there is no Save here, only moving projects around. */
export function ProjectsHome({ engine, library, onOpen, onNew }: Props) {
  const { t, locale } = useI18n();
  const [list, setList] = useState(() => library.list());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ProjectMeta | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const refresh = useCallback(() => setList(library.list()), [library]);
  const when = (at: number) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(at);

  const run = async (id: string, job: () => Promise<void>) => {
    setBusy(id);
    setProblem(null);
    try { await job(); } catch (e) { setProblem(t("home.failed", { message: e instanceof Error ? e.message : String(e) })); }
    setBusy(null);
    refresh();
  };
  const openFile = () => engine && void run("file", async () => {
    const bytes = await pickProjectFile();
    if (!bytes) return;
    const made = await importProject(engine, library, bytes, null);
    announce(t("home.opened", { name: made.name }));
  });
  const commitRename = (m: ProjectMeta, value: string) => {
    setRenaming(null);
    if (value.trim() && value.trim() !== m.name) library.rename(m.id, value);
    refresh();
  };

  return (
    <main className="home" data-testid="projects-home">
      <header className="home-head">
        <div className="brand"><span className="logo" aria-hidden="true"><Icon name="split" size={16} /></span><strong>{t("app.name")}</strong></div>
        <h1>{t("home.title")}</h1>
        <div className="home-actions">
          <button className="chip-btn" onClick={openFile} disabled={!engine || busy !== null} data-testid="home-open-file"><Icon name="upload" size={18} /><span>{t("home.openFile")}</span></button>
          <button className="primary" onClick={onNew} data-testid="home-new"><Icon name="plus" size={18} /><span>{t("home.new")}</span></button>
        </div>
      </header>
      {problem && <p className="export-error" role="alert" data-testid="home-problem">{problem}</p>}
      {list.length === 0 ? (
        <div className="home-empty" data-testid="home-empty">
          <Icon name="film" size={30} />
          <strong>{t("home.empty.title")}</strong>
          <p>{t("home.empty.text")}</p>
        </div>
      ) : (
        <ul className="project-grid" data-testid="project-list">
          {list.map((m) => (
            <li key={m.id} className="project-card" data-testid="project-card" data-busy={busy === m.id}>
              <button className="project-open" onClick={() => onOpen(m.id)} disabled={busy !== null} aria-label={t("home.open", { name: m.name })} data-testid="project-open">
                <span className="project-thumb" style={{ aspectRatio: m.width && m.height ? `${m.width} / ${m.height}` : "16 / 9" }}>
                  {m.thumb ? <img src={m.thumb} alt="" /> : <Icon name="film" size={26} />}
                </span>
              </button>
              <div className="project-info">
                {renaming === m.id ? (
                  <input className="project-rename" autoFocus defaultValue={m.name} maxLength={60} aria-label={t("project.name")} data-testid="project-rename"
                    onBlur={(e) => commitRename(m, e.currentTarget.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") commitRename(m, e.currentTarget.value); else if (e.key === "Escape") setRenaming(null); }} />
                ) : (
                  <strong className="project-name-text" data-testid="project-name">{m.name}</strong>
                )}
                <span>{formatDuration(Math.round(m.seconds * TICKS)) || t("home.noClips")}{m.width ? ` · ${m.width}×${m.height}` : ""}</span>
                <span>{t("home.edited", { when: when(m.updatedAt) })}</span>
              </div>
              <div className="project-actions">
                <button className="chip-btn" onClick={() => onOpen(m.id)} disabled={busy !== null} data-testid="project-open-btn">{t("home.openProject")}</button>
                <button className="chip-btn" onClick={() => setRenaming(m.id)} disabled={busy !== null} data-testid="project-rename-btn">{t("home.rename")}</button>
                <button className="chip-btn" disabled={!engine || busy !== null} data-testid="project-duplicate" onClick={() => engine && void run(m.id, async () => { const c = await duplicateProject(engine, library, m.id); announce(t("home.duplicated", { name: c.name })); })}>{t("home.duplicate")}</button>
                <button className="chip-btn" disabled={!engine || busy !== null} data-testid="project-export" onClick={() => engine && void run(m.id, async () => { if (await deliverProjectFile(await projectBytes(engine, m.id, m.name), m.name)) announce(t("home.exported", { name: m.name })); })}>{t("home.export")}</button>
                <button className="chip-btn danger" onClick={() => setConfirm(m)} disabled={busy !== null} data-testid="project-delete">{t("home.delete")}</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="export-note home-note">{t("home.note")}</p>
      {confirm && (
        <Sheet title={t("home.delete.title", { name: confirm.name })} onClose={() => setConfirm(null)} testid="delete-confirm">
          <p>{t("home.delete.text")}</p>
          <div className="export-actions">
            <button className="export-secondary" onClick={() => setConfirm(null)} data-testid="delete-cancel">{t("home.cancel")}</button>
            <button className="export-secondary export-danger" data-testid="delete-confirm-go" onClick={() => { const m = confirm; setConfirm(null); void run(m.id, async () => { await deleteProject(library, m.id); announce(t("home.deleted", { name: m.name })); }); }}>{t("home.delete.go")}</button>
          </div>
        </Sheet>
      )}
    </main>
  );
}
