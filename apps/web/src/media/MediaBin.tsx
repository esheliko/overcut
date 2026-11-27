import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { Modal } from "../ProjectDialogs";
import { DEFAULT_FILTER, allTags, viewBin, windowRange, withTag, withoutTag, type BinFilter, type BinMeta, type BinSort } from "./binView";
import { formatBytes, formatDuration, iconForKind, offlineReason } from "./plan";
import { ACCEPT, BIN_DRAG_TYPE, fromFileList, hasHandlePicker, pickWithHandles, type Source } from "./sources";
import type { BinItem } from "./useMediaBin";
import { useProjectStore } from "../store/projectStore";

type Props = {
  items: BinItem[];
  /** Case-insensitive name filter from the search box. */
  query: string;
  /** Tags and order per media id (from the project). */
  meta: BinMeta;
  onTags: (id: string, tags: readonly string[]) => void;
  onImport: (s: Source[]) => void;
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
  onRelink: (id: string) => void;
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

function Card({ item, tags, onTimeline, onAdd, onRemove, onRelink, onEditTags }: { item: BinItem; tags: readonly string[]; onTimeline: boolean; onEditTags?: (id: string) => void } & Pick<Props, "onAdd" | "onRemove" | "onRelink">) {
  const { t } = useI18n();
  const ready = item.status === "ready";
  const meta = [
    item.kind !== "image" && formatDuration(item.durationTicks),
    item.width && item.height ? `${item.width}×${item.height}` : "",
    item.codec,
    formatBytes(item.size),
  ].filter(Boolean).join(" · ");
  return (
    <li
      className="bin-card"
      data-status={item.status}
      data-testid="bin-item"
      data-on={onTimeline || undefined}
      draggable={ready}
      onDragStart={(e) => { e.dataTransfer.setData(BIN_DRAG_TYPE, item.id); e.dataTransfer.effectAllowed = "copy"; }}
    >
      <span className="bin-thumb" aria-hidden="true">
        {item.poster ? <img src={item.poster} alt="" draggable={false} /> : <Icon name={iconForKind(item.kind)} size={22} />}
      </span>
      <span className="bin-text">
        <strong title={item.name}>{item.name}</strong>
        {item.status === "probing" && <span role="status">{t("media.reading")}</span>}
        {ready && (
          <span className="bin-line">
            {/* "On the timeline" is a check mark in the meta line (its words stay for screen readers and as the tooltip): one line less per card */}
            {onTimeline && <span className="bin-on-timeline" data-testid="bin-on-timeline" title={t("media.onTimeline")}><Icon name="check" size={14} aria-hidden="true" /><span className="sr-only">{t("media.onTimeline")}</span></span>}
            <span className="bin-meta" title={meta}>{meta}</span>
          </span>
        )}
        {tags.length > 0 && <span className="bin-tags" data-testid="bin-tags">{tags.map((x) => `#${x}`).join(" ")}</span>}
        {item.status === "offline" && <span role="alert">{t(offlineReason(item.uri) === "reopen" ? "media.offline.reopen" : "media.offline")}</span>}
        {item.status === "unsupported" && <span role="alert" className="bin-error">{item.message}</span>}
        {item.status === "offline" && <button className="bin-link" style={{ alignSelf: "flex-start", marginBlockStart: 4 }} onClick={() => onRelink(item.id)} aria-label={t("media.relinkNamed", { name: item.name })}>{t("media.relink")}</button>}
      </span>
      {onEditTags && <button className="bin-act bin-tag-btn" aria-label={t("media.tags.edit", { name: item.name })} title={t("media.tags.editShort")} onClick={() => onEditTags(item.id)} data-testid="bin-tag-edit"><Icon name="tag" size={18} /><span>{t("media.tags.editShort")}</span></button>}
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

/** Media tool panel body: the big empty-state target, then the list of imported media with "+" to add each to the timeline. */
export function MediaBin({ items, query, meta, onTags, onImport, onAdd, onRemove, onRelink, onRelinkAll }: Props) {
  const { t } = useI18n();
  const { open, field } = useImportPicker(onImport);
  const project = useProjectStore((s) => s.project);
  /** Media already placed on a timeline: its card offers no "+" (adding it again only duplicates the clip). */
  const onTimeline = useMemo(() => new Set((project?.sequences ?? []).flatMap((q) => q.tracks.flatMap((tr) => tr.clips.map((c) => c.media)))), [project]);
  const [filter, setFilter] = useState<BinFilter>(DEFAULT_FILTER);
  const [editing, setEditing] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const tagList = allTags(meta);
  const activeTag = tagList.some((x) => x.toLowerCase() === filter.tag.toLowerCase()) ? filter.tag : ""; // a tag nobody uses any more stops filtering
  const shown = viewBin(items, meta, { ...filter, tag: activeTag, query });
  const filtersOn = filter.kind !== DEFAULT_FILTER.kind || activeTag !== "" || filter.sort !== DEFAULT_FILTER.sort; // shown on the toggle, so a hidden filter is not forgotten
  const editItem = editing ? items.find((i) => i.id === editing) : undefined;
  const card = (i: BinItem) => <Card key={i.id} item={i} tags={meta.get(i.id)?.tags ?? []} onTimeline={onTimeline.has(i.id)} onAdd={onAdd} onRemove={onRemove} onRelink={onRelink} onEditTags={meta.has(i.id) ? setEditing : undefined} />;
  const pending = shown.filter((i) => !meta.has(i.id));
  const settled = shown.filter((i) => meta.has(i.id));
  if (items.length === 0) {
    return (
      <>
        {field}
        <button className="dropzone dropzone-big" onClick={open} data-testid="import-empty">
          <span className="drop-icon"><Icon name="upload" size={30} /></span>
          <strong>{t("media.import")}</strong>
          <span>{t("media.importHint")}</span>
        </button>
      </>
    );
  }
  return (
    <div className="bin">
      {field}
      {/* Import and Filter and sort share one row, so the media starts higher in the panel */}
      <div className="bin-bar">
      <button className="primary bin-import" onClick={open} data-testid="import-more"><Icon name="plus" size={18} /><span>{t("media.import")}</span></button>
      {onRelinkAll && items.filter((i) => i.status === "offline").length >= 2 && (
        <button className="bin-filter-toggle bin-relink-all" onClick={onRelinkAll} data-testid="relink-all"><Icon name="upload" size={18} /><span>{t("media.relinkAll", { count: items.filter((i) => i.status === "offline").length })}</span></button>
      )}
      <button
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
      </div>
      {filterOpen && (
        <div id="bin-filter-panel" className="bin-filters" role="group" aria-label={t("media.filterSort")} data-testid="bin-filter-panel">
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
        </div>
      )}
      <p className="bin-count" role="status" data-testid="bin-count" data-quiet={!query && !filtersOn}>{t("media.count", { shown: settled.length, total: meta.size })}</p>
      {shown.length === 0 ? <p className="bin-none">{query ? t("media.noMatch", { query }) : t("media.noFilterMatch")}</p> : (
        <>
          {pending.length > 0 && <ul className="bin-list" aria-label={t("media.list")}>{pending.map(card)}</ul>}
          {settled.length > WINDOW_FROM
            ? <Windowed items={settled} render={card} />
            : settled.length > 0 && <ul className="bin-list" aria-label={t("media.list")}>{settled.map(card)}</ul>}
        </>
      )}
      {editItem && meta.has(editItem.id) && <TagsDialog item={editItem} tags={meta.get(editItem.id)!.tags} onTags={onTags} onClose={() => setEditing(null)} />}
    </div>
  );
}
