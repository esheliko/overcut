import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { Modal } from "../ProjectDialogs";
import { DEFAULT_FILTER, allTags, viewBin, windowRange, withTag, withoutTag, type BinFilter, type BinMeta, type BinSort } from "./binView";
import { formatBytes, formatDuration, iconForKind, offlineReason } from "./plan";
import { IMPORT_FORMATS } from "./formats";
import { ACCEPT, BIN_DRAG_TYPE, fromFileList, hasHandlePicker, pickWithHandles, type Source } from "./sources";
import type { BinItem } from "./useMediaBin";
import { useProjectStore } from "../store/projectStore";
import "./media.css";

type Props = {
  items: BinItem[];
  /** Case-insensitive name filter from the search box. */
  query: string;
  /** Tags and order per media id (from the project). */
  meta: BinMeta;
  onTags: (id: string, tags: readonly string[]) => void;
  onImport: (s: Source[]) => void;
  onAdd: (id: string) => void;
  /** Picture-in-picture: the item on a new video track above, at the playhead (the timeline's "Add as overlay"). Absent: no such button. */
  onAddOverlay?: (id: string) => void;
  onRemove: (id: string) => void;
  onRelink: (id: string) => void;
  /** One click that asks permission for every file the browser kept a handle for (after a reload). Absent: no such button. */
  onAllow?: () => void;
  /** One file picker for every offline item (matched by name): offered when two or more are offline. */
  onRelinkAll?: () => void;
};

/** The picker control: Chromium desktop gets persistent handles, everything else the plain input (which opens the camera roll on a phone). */
export function useImportPicker(onImport: (s: Source[]) => void, testId = "media-input") {
  const input = useRef<HTMLInputElement>(null);
  const open = () => {
    if (hasHandlePicker()) void pickWithHandles().then(onImport).catch(() => input.current?.click());
    else input.current?.click();
  };
  const field = (
    <input
      ref={input}
      type="file"
      multiple
      accept={ACCEPT}
      hidden
      data-testid={testId}
      onChange={(e) => {
        onImport(fromFileList(e.target.files));
        e.target.value = ""; // the same file can be picked again
      }}
    />
  );
  return { open, field };
}

function Card({ item, tags, onTimeline, uses, selected, onSelect, onAdd, onAddOverlay, onRemove, onRelink, onAllow, onEditTags }: { item: BinItem; tags: readonly string[]; onTimeline: boolean; uses: number; selected: boolean; onSelect: (id: string) => void; onEditTags?: (id: string) => void } & Pick<Props, "onAdd" | "onAddOverlay" | "onRemove" | "onRelink" | "onAllow">) {
  const { t } = useI18n();
  const ready = item.status === "ready";
  // The duration is a badge on the poster; the meta line keeps what does not fit there (size first, so a narrow panel cuts the codec, never the size). The full line is the tooltip.
  const duration = ready && item.kind !== "image" ? formatDuration(item.durationTicks) : "";
  const meta = [
    item.width && item.height ? `${item.width}×${item.height}` : "",
    formatBytes(item.size),
    item.codec,
  ].filter(Boolean).join(" · ");
  const tooltip = [duration, item.width && item.height ? `${item.width}×${item.height}` : "", item.codec, formatBytes(item.size)].filter(Boolean).join(" · ");
  const offline = item.status === "offline";
  const needsPermission = offline && !!item.needsPermission;
  return (
    <li
      className="bin-card"
      data-status={item.status}
      data-testid="bin-item"
      data-on={onTimeline || undefined}
      data-selected={selected || undefined}
      draggable={ready}
      onClick={ready ? () => onSelect(item.id) : undefined}
      onDragStart={(e) => { e.dataTransfer.setData(BIN_DRAG_TYPE, item.id); e.dataTransfer.effectAllowed = "copy"; }}
    >
      <span className="bin-thumb" aria-hidden="true">
        {item.poster ? <img src={item.poster} alt="" draggable={false} /> : <Icon name={offline ? "warn" : iconForKind(item.kind)} size={22} />}
        {duration && <span className="bin-dur">{duration}</span>}
      </span>
      <span className="bin-text">
        <strong title={item.name}>{breakable(item.name)}</strong>
        {item.status === "probing" && <span role="status">{t("media.reading")}</span>}
        {ready && (
          <span className="bin-line">
            {onTimeline && <span className="bin-on-timeline" data-testid="bin-on-timeline" title={t("media.onTimeline")}><Icon name="check" size={12} strokeWidth={3} aria-hidden="true" /><span className="bin-on-label">{t("media.onTimeline")}{uses > 1 ? ` ×${uses}` : ""}</span></span>}
            <span className="bin-meta" title={tooltip}>{meta}</span>
          </span>
        )}
        {tags.length > 0 && <span className="bin-tags" data-testid="bin-tags">{tags.map((x) => `#${x}`).join(" ")}</span>}
        {offline && <span role="alert" data-testid={needsPermission ? "bin-needs-permission" : undefined}>{t(needsPermission ? "media.permission.card" : offlineReason(item.uri) === "reopen" ? "media.offline.missing" : "media.offline")}</span>}
        {item.status === "unsupported" && (
          <span role="alert" className="bin-error" data-testid="bin-error">
            <span className="bin-error-text">{item.message}</span>
            {item.details && (
              <details className="bin-error-details">
                <summary>{t("media.err.details")}</summary>
                <span>{[item.details, t("media.err.works")].join(" ")}</span>
              </details>
            )}
          </span>
        )}
        {needsPermission && onAllow && <button className="bin-link" onClick={onAllow} data-testid="bin-allow">{t("media.permission.allow")}</button>}
        {offline && !needsPermission && offlineReason(item.uri) !== "reopen" && <button className="bin-link" onClick={() => onRelink(item.id)} aria-label={t("media.relinkNamed", { name: item.name })}>{t("media.relink")}</button>}
      </span>
      {onEditTags && <button className="bin-act bin-tag-btn" aria-label={t("media.tags.edit", { name: item.name })} title={t("media.tags.editShort")} onClick={() => onEditTags(item.id)} data-testid="bin-tag-edit"><Icon name="tag" size={18} /><span className="sr-only">{t("media.tags.editShort")}</span></button>}
      {ready && onAddOverlay && item.kind !== "audio" && !onTimeline && <button className="bin-act bin-tag-btn bin-overlay-btn" aria-label={t("media.addOverlay", { name: item.name })} title={t("media.addOverlayShort")} onClick={() => onAddOverlay(item.id)} data-testid="bin-add-overlay"><Icon name="overlay" size={20} /></button>}
      {ready && <button className="icon-btn bin-act" aria-label={t("media.add", { name: item.name })} title={t("media.addShort")} onClick={() => onAdd(item.id)}><Icon name="plus" size={20} /></button>}
      {item.status === "unsupported" && <button className="icon-btn bin-act" aria-label={t("media.dismiss", { name: item.name })} onClick={() => onRemove(item.id)}><Icon name="close" size={18} /></button>}
    </li>
  );
}

const ROW = 62; // card (56) + gap (6): fixed in the windowed list
const WINDOW_FROM = 100; // longer lists render only the rows in view

/** Long lists (a 10k-item bin): only the rows near the viewport exist in the DOM; the panel body scrolls. */
function Windowed({ items, render }: { items: BinItem[]; render: (i: BinItem) => React.ReactNode }) {
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<[number, number]>([0, 30]);
  useEffect(() => {
    const el = box.current;
    const scroller = el?.closest<HTMLElement>(".panel-body");
    if (!el || !scroller) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      setRange((old) => { const r = windowRange(scroller.scrollTop, scroller.clientHeight, top, ROW, items.length); return r[0] === old[0] && r[1] === old[1] ? old : r; });
    };
    const queue = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    scroller.addEventListener("scroll", queue, { passive: true });
    const ro = new ResizeObserver(queue);
    ro.observe(scroller);
    return () => { scroller.removeEventListener("scroll", queue); ro.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [items.length]);
  return (
    <div ref={box} className="bin-virtual" style={{ blockSize: items.length * ROW }}>
      <ul className="bin-list bin-fixed" aria-label={t("media.list")} style={{ transform: `translateY(${range[0] * ROW}px)` }}>
        {items.slice(range[0], range[1]).map(render)}
      </ul>
    </div>
  );
}

const SORTS: BinSort[] = ["added", "name", "duration"];
const KINDS: BinFilter["kind"][] = ["all", "video", "audio", "image"];

/** Tags of one media item: chips with a remove button, and a field to add one (Enter). Each change is one undoable edit. */
function TagsDialog({ item, tags, onTags, onClose }: { item: BinItem; tags: readonly string[]; onTags: Props["onTags"]; onClose(): void }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const add = () => { const next = withTag(tags, text); if (next !== tags) onTags(item.id, next); setText(""); };
  return (
    <Modal title={t("media.tags.title", { name: item.name })} titleId="tags-title" testId="tags-dialog" onClose={onClose}>
      <ul className="tag-chips" aria-label={t("media.tags.list")}>
        {tags.length === 0 && <li className="export-note">{t("media.tags.none")}</li>}
        {tags.map((x) => (
          <li key={x}><span>{x}</span><button className="icon-btn" aria-label={t("media.tags.remove", { tag: x })} onClick={() => onTags(item.id, withoutTag(tags, x))} data-testid="tag-remove"><Icon name="close" size={16} /></button></li>
        ))}
      </ul>
      <form className="versions-save" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <label>{t("media.tags.add")}
          <input value={text} maxLength={40} onChange={(e) => setText(e.target.value)} data-testid="tag-input" />
        </label>
        <button type="submit" className="export-go" disabled={!text.trim()} data-testid="tag-add">{t("media.tags.addButton")}</button>
      </form>
    </Modal>
  );
}


/**
 * Filter and sort as a compact popover anchored to its button (UX r15 D2, customer: "ten times worse"): a menu surface that floats over the cards instead of an inline
 * panel that pushes them down. Rows are 32 px with a mouse, 44 px on touch. It stays open while the controls are used; Escape, a tap outside or the button closes it.
 * Portaled to the page, so no scroll container of the library clips it; it is placed under the button (above it when there is no room) and kept inside the viewport.
 */
function FilterPop({ anchor, label, onClose, children }: { anchor: RefObject<HTMLElement | null>; label: string; onClose(): void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = box.current, a = anchor.current?.getBoundingClientRect();
    if (!el || !a) return;
    const w = el.offsetWidth, h = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    const below = a.bottom + 4;
    setPos({ left: Math.max(8, Math.min(a.right - w, vw - w - 8)), top: below + h <= vh - 8 ? below : Math.max(8, a.top - h - 4) });
  }, [anchor]);
  useEffect(() => { box.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    const away = (e: Event) => { const n = e.target as Node; if (!box.current?.contains(n) && !anchor.current?.contains(n)) onClose(); };
    const key = (e: KeyboardEvent) => { const n = e.target as Node; if (e.key === "Escape" && (box.current?.contains(n) || anchor.current?.contains(n))) { e.stopPropagation(); onClose(); anchor.current?.focus({ preventScroll: true }); } };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", key, true); };
  }, [anchor, onClose]);
  return createPortal(
    <div ref={box} id="bin-filter-panel" className="bin-filters" role="group" aria-label={label} data-testid="bin-filter-panel" style={{ left: pos?.left ?? -9999, top: pos?.top ?? 0 }}>{children}</div>,
    document.body,
  );
}

/** Media tool panel body: the big empty-state target, then the list of imported media with "+" to add each to the timeline. */
export function MediaBin({ items, query, meta, onTags, onImport, onAdd, onAddOverlay, onRemove, onRelink, onAllow, onRelinkAll }: Props) {
  const { t } = useI18n();
  const { open, field } = useImportPicker(onImport);
  const project = useProjectStore((s) => s.project);
  /** Media already placed on a timeline: its card offers no "+" (adding it again only duplicates the clip). */
  const uses = useMemo(() => {
    // How many times each media is used: its picture clips (the sound that came with a video is not a second use); a sound-only media counts its audio clips.
    const video = new Map<string, number>();
    const audio = new Map<string, number>();
    for (const q of project?.sequences ?? []) for (const tr of q.tracks) for (const c of tr.clips) { const m = tr.kind === "video" ? video : audio; m.set(c.media, (m.get(c.media) ?? 0) + 1); }
    const m = new Map(audio);
    for (const [id, n] of video) m.set(id, n);
    return m;
  }, [project]);
  const [viewPref, setViewState] = useState<"list" | "grid">(() => { try { return localStorage.getItem("overcut.binView") === "list" ? "list" : "grid"; } catch { return "grid"; } });
  const setView = (v: "list" | "grid") => { setViewState(v); try { localStorage.setItem("overcut.binView", v); } catch { /* private mode: the choice just is not remembered */ } };
  const [filter, setFilter] = useState<BinFilter>(DEFAULT_FILTER);
  const [editing, setEditing] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null); // the card last tapped: the one the "+" next to it will add
  const [filterOpen, setFilterOpen] = useState(false);
  const filterBtn = useRef<HTMLButtonElement>(null);
  const tagList = allTags(meta);
  const activeTag = tagList.some((x) => x.toLowerCase() === filter.tag.toLowerCase()) ? filter.tag : ""; // a tag nobody uses any more stops filtering
  const shown = viewBin(items, meta, { ...filter, tag: activeTag, query });
  const filtersOn = filter.kind !== DEFAULT_FILTER.kind || activeTag !== "" || filter.sort !== DEFAULT_FILTER.sort; // shown on the toggle, so a hidden filter is not forgotten
  const editItem = editing ? items.find((i) => i.id === editing) : undefined;
  const card = (i: BinItem) => <Card key={i.id} item={i} tags={meta.get(i.id)?.tags ?? []} onTimeline={uses.has(i.id)} uses={uses.get(i.id) ?? 0} selected={selected === i.id} onSelect={setSelected} onAdd={onAdd} onAddOverlay={onAddOverlay} onRemove={onRemove} onRelink={onRelink} onAllow={onAllow} onEditTags={meta.has(i.id) ? setEditing : undefined} />;
  const pending = shown.filter((i) => !meta.has(i.id));
  const settled = shown.filter((i) => meta.has(i.id));
  const long = settled.length > WINDOW_FROM; // a long bin is the windowed list (only the rows in view exist in the DOM); posters in a grid would all be rendered
  const view = long ? "list" : viewPref;
  if (items.length === 0) {
    return (
      <>
        {field}
        <button className="dropzone dropzone-big" onClick={open} data-testid="import-empty">
          <span className="drop-icon"><Icon name="upload" size={30} /></span>
          <strong>{t("media.import")}</strong>
          <span>{t(typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches ? "media.importHint.touch" : "media.importHint")}</span>
          <span className="drop-formats" aria-label={t("media.formats")}>{IMPORT_FORMATS.map((f) => <span key={f}>{f}</span>)}</span>
        </button>
      </>
    );
  }
  return (
    <div className="bin" data-view={view}>
      {field}
      {/* Import and Filter and sort share one row, so the media starts higher in the panel */}
      <div className="bin-bar">
      <button className="primary bin-import" onClick={open} data-testid="import-more"><Icon name="plus" size={18} /><span>{t("media.import")}</span></button>
      {onAllow && items.some((i) => i.needsPermission) && (
        <button className="bin-filter-toggle bin-relink-all" onClick={onAllow} data-testid="allow-all"><Icon name="check" size={18} /><span>{t("media.permission.allow")}</span></button>
      )}
      {onRelinkAll && items.filter((i) => i.status === "offline" && !i.needsPermission && offlineReason(i.uri) !== "reopen").length >= 2 && (
        <button className="bin-filter-toggle bin-relink-all" onClick={onRelinkAll} data-testid="relink-all"><Icon name="upload" size={18} /><span>{t("media.relinkAll", { count: items.filter((i) => i.status === "offline" && !i.needsPermission && offlineReason(i.uri) !== "reopen").length })}</span></button>
      )}
      <button
        ref={filterBtn}
        className="bin-filter-toggle"
        title={t("media.filterSort")}
        aria-expanded={filterOpen}
        aria-controls="bin-filter-panel"
        onClick={() => setFilterOpen((o) => !o)}
        data-testid="bin-filter-toggle"
      >
        <Icon name="filters" size={18} />
        <span>{t("media.filterSort")}</span>
        {filtersOn && <span className="bin-on" data-testid="bin-filter-on">{t("media.filterOn")}</span>}
      </button>
      {!long && <button className="bin-view-btn" aria-pressed={view === "list"} aria-label={t("media.view.list")} title={t("media.view.list")} onClick={() => setView(view === "list" ? "grid" : "list")} data-testid="bin-view-toggle"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true" focusable="false"><path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r="1" fill="currentColor" /><circle cx="4.5" cy="12" r="1" fill="currentColor" /><circle cx="4.5" cy="18" r="1" fill="currentColor" /></svg></button>}
      </div>
      {filterOpen && (
        <FilterPop anchor={filterBtn} label={t("media.filterSort")} onClose={() => setFilterOpen(false)}>
          <div className="bin-kinds">
            {KINDS.map((k) => <button key={k} className="bin-chip" aria-pressed={filter.kind === k} onClick={() => setFilter({ ...filter, kind: k })} data-testid={`bin-kind-${k}`}>{t(`media.kind.${k}`)}</button>)}
          </div>
          <div className="bin-selects">
            <label className="bin-select">{t("media.sort")}
              <select value={filter.sort} onChange={(e) => setFilter({ ...filter, sort: e.target.value as BinSort })} data-testid="bin-sort">
                {SORTS.map((s) => <option key={s} value={s}>{t(`media.sort.${s}`)}</option>)}
              </select>
            </label>
            {tagList.length > 0 && (
              <label className="bin-select">{t("media.tags.filter")}
                <select value={activeTag} onChange={(e) => setFilter({ ...filter, tag: e.target.value })} data-testid="bin-tag-filter">
                  <option value="">{t("media.tags.all")}</option>
                  {tagList.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              </label>
            )}
          </div>
        </FilterPop>
      )}
      <p className="bin-count" role="status" data-testid="bin-count" data-quiet={!query && !filtersOn}>{t("media.count", { shown: settled.length, total: meta.size })}</p>
      {shown.length === 0 ? <p className="bin-none">{query ? t("media.noMatch", { query }) : t("media.noFilterMatch")}</p> : (
        <>
          {pending.length > 0 && <ul className="bin-list" data-view={view} aria-label={t("media.list")}>{pending.map(card)}</ul>}
          {long
            ? <Windowed items={settled} render={card} />
            : settled.length > 0 && <ul className="bin-list" data-view={view} aria-label={t("media.list")}>{settled.map(card)}</ul>}
        </>
      )}
      {editItem && meta.has(editItem.id) && <TagsDialog item={editItem} tags={meta.get(editItem.id)!.tags} onTags={onTags} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** A file name that may break after "_", "-" and "." (a long name like beach_1080p.mp4 wraps at a separator, not in the middle of a word; r16 FIRST-12). The text stays the same: <wbr> adds no characters. */
function breakable(name: string) {
  const parts = name.split(/(?<=[_.-])/);
  return parts.map((p, i) => (i === 0 ? p : <span key={i}><wbr />{p}</span>));
}
