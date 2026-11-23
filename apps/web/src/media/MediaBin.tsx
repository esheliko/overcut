import type { MediaKind } from "@app/engine-client";
import { useRef } from "react";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { formatBytes, formatDuration } from "./plan";
import { ACCEPT, BIN_DRAG_TYPE, fromFileList, hasHandlePicker, pickWithHandles, type Source } from "./sources";
import type { BinItem } from "./useMediaBin";

type Props = {
  items: BinItem[];
  /** Case-insensitive name filter from the search box. */
  query: string;
  onImport: (s: Source[]) => void;
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
  onRelink: (id: string) => void;
};

const KIND_ICON: Record<MediaKind, "video" | "audio" | "media"> = { video: "video", audio: "audio", image: "media" };

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

function Card({ item, onAdd, onRemove, onRelink }: { item: BinItem } & Pick<Props, "onAdd" | "onRemove" | "onRelink">) {
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
      draggable={ready}
      onDragStart={(e) => { e.dataTransfer.setData(BIN_DRAG_TYPE, item.id); e.dataTransfer.effectAllowed = "copy"; }}
    >
      <span className="bin-thumb" aria-hidden="true">
        {item.poster ? <img src={item.poster} alt="" draggable={false} /> : <Icon name={KIND_ICON[item.kind]} size={22} />}
      </span>
      <span className="bin-text">
        <strong title={item.name}>{item.name}</strong>
        {item.status === "probing" && <span role="status">{t("media.reading")}</span>}
        {ready && <span>{meta}</span>}
        {item.status === "offline" && <span role="alert">{t("media.offline")}</span>}
        {item.status === "unsupported" && <span role="alert" className="bin-error">{item.message}</span>}
      </span>
      {ready && <button className="icon-btn bin-act" aria-label={t("media.add", { name: item.name })} title={t("media.addShort")} onClick={() => onAdd(item.id)}><Icon name="plus" size={20} /></button>}
      {item.status === "offline" && <button className="bin-link" onClick={() => onRelink(item.id)}>{t("media.relink")}</button>}
      {item.status === "unsupported" && <button className="icon-btn bin-act" aria-label={t("media.dismiss", { name: item.name })} onClick={() => onRemove(item.id)}><Icon name="close" size={18} /></button>}
    </li>
  );
}

/** Media tool panel body: the big empty-state target, then the list of imported media with "+" to add each to the timeline. */
export function MediaBin({ items, query, onImport, onAdd, onRemove, onRelink }: Props) {
  const { t } = useI18n();
  const { open, field } = useImportPicker(onImport);
  const q = query.trim().toLowerCase();
  const shown = q ? items.filter((i) => i.name.toLowerCase().includes(q)) : items;
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
      <button className="primary bin-import" onClick={open} data-testid="import-more"><Icon name="plus" size={18} /><span>{t("media.import")}</span></button>
      {shown.length === 0 ? <p className="bin-none">{t("media.noMatch", { query })}</p> : (
        <ul className="bin-list" aria-label={t("media.list")}>
          {shown.map((i) => <Card key={i.id} item={i} onAdd={onAdd} onRemove={onRemove} onRelink={onRelink} />)}
        </ul>
      )}
    </div>
  );
}
