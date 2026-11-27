import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { rememberFocus } from "../a11y/restoreFocus";
import { useI18n } from "../i18n";
import type { Toggle } from "./header";
import type { Scene } from "./scene";
import { cleanName, isOn, rowRange } from "./tracks";
import { Icon } from "../icons";

export type TrackMenuTarget = { kind: "track"; track: number } | { kind: "add" };
export type TrackAction =
  | { a: "toggle"; track: number; part: Toggle }
  | { a: "rename"; track: number; name: string }
  | { a: "remove"; track: number }
  | { a: "move"; track: number; to: number }
  | { a: "add"; kind: "video" | "audio" };

type Props = { scene: Scene; target: TrackMenuTarget; anchor: DOMRect; onAct: (a: TrackAction) => void; onClose: () => void };

/** Track menu (header tap / right click / "Track options" button) and the "Add track" menu. Every row is a 44 px button; arrow keys move, Escape closes and hands focus back. */
export function TrackMenu({ scene, target, anchor, onAct, onClose }: Props) {
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const track = target.kind === "track" ? target.track : -1;
  const [draft, setDraft] = useState(track >= 0 ? scene.trackName[track]! : "");
  const [back] = useState(rememberFocus); // the element that opened the menu, remembered once
  const close = () => { onClose(); back(); };
  const closeRef = useRef(close);
  closeRef.current = close;
  const act = (a: TrackAction) => { onAct(a); onClose(); back(); };

  // Place beside the anchor, kept inside the viewport.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    const left = Math.max(8, Math.min(anchor.right + 4, vw - w - 8));
    setPos({ left: left + w > vw - 8 ? Math.max(8, anchor.left) : left, top: Math.max(8, Math.min(anchor.top, vh - h - 8)) });
  }, [anchor, renaming]);
  useEffect(() => { (box.current?.querySelector<HTMLElement>("input, button:not(:disabled)"))?.focus({ preventScroll: true }); }, [renaming]);
  useEffect(() => {
    const away = (e: Event) => { if (!box.current?.contains(e.target as Node)) onClose(); };
    // Escape closes the menu wherever focus is (it may still sit on the canvas after a right click or a tap), and focus goes back to where it came from.
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); closeRef.current(); } };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", esc, true);
    return () => { document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", esc, true); };
  }, [onClose]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (renaming) return;
    const items = [...(box.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = e.key === "ArrowDown" ? at + 1 : e.key === "ArrowUp" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : null;
    if (go !== null && items.length) { e.preventDefault(); items[(go + items.length) % items.length]!.focus(); }
    if (e.key === "Tab") { e.preventDefault(); close(); }
  };

  const row = (label: string, onClick: () => void, o: { testid?: string; disabled?: boolean; on?: boolean; danger?: boolean } = {}) => (
    <button key={label} className="menu-row" role={o.on === undefined ? "menuitem" : "menuitemcheckbox"} aria-checked={o.on} disabled={o.disabled} data-testid={o.testid} data-danger={o.danger || undefined} onClick={onClick}>
      {o.on !== undefined && <span className="menu-check" aria-hidden="true">{o.on && <Icon name="check" size={16} />}</span>}<span>{label}</span>
    </button>
  );

  const menuLabel = target.kind === "add" ? t("timeline.track.add") : t("timeline.track.options", { name: scene.trackName[track]! });
  let body;
  if (target.kind === "add") {
    body = <>
      {row(t("timeline.track.addVideo"), () => act({ a: "add", kind: "video" }), { testid: "track-add-video" })}
      {row(t("timeline.track.addAudio"), () => act({ a: "add", kind: "audio" }), { testid: "track-add-audio" })}
    </>;
  } else if (renaming) {
    const ok = cleanName(draft) !== null;
    body = (
      <form className="tl-rename" onSubmit={(e) => { e.preventDefault(); if (ok) act({ a: "rename", track, name: draft }); }}>
        <label>{t("timeline.track.name")}<input value={draft} maxLength={64} onChange={(e) => setDraft(e.target.value)} onFocus={(e) => e.currentTarget.select()} data-testid="track-name-input" /></label>
        <button type="submit" className="menu-row" disabled={!ok}>{t("timeline.track.rename.apply")}</button>
      </form>
    );
  } else {
    const { lo, hi } = rowRange(scene, track);
    const lockedNote = scene.trackLocked[track] === 1;
    const audio = scene.trackKind[track] === 1; // video tracks have no mute / solo (their sound is on the linked audio track)
    body = <>
      <div className="menu-group" role="presentation">{scene.trackName[track]}</div>
      {(audio || isOn(scene, track, "mute")) && row(t("timeline.track.mute"), () => act({ a: "toggle", track, part: "mute" }), { on: isOn(scene, track, "mute"), testid: "track-mute" })}
      {(audio || isOn(scene, track, "solo")) && row(t("timeline.track.solo"), () => act({ a: "toggle", track, part: "solo" }), { on: isOn(scene, track, "solo"), testid: "track-solo" })}
      {row(t("timeline.track.lock"), () => act({ a: "toggle", track, part: "lock" }), { on: isOn(scene, track, "lock"), testid: "track-lock" })}
      {row(t("timeline.track.hide"), () => act({ a: "toggle", track, part: "hide" }), { on: isOn(scene, track, "hide"), testid: "track-hide" })}
      <div className="menu-group" role="presentation">{t("timeline.track.arrange")}</div>
      {row(t("timeline.track.rename"), () => setRenaming(true), { testid: "track-rename" })}
      {row(t("timeline.track.up"), () => act({ a: "move", track, to: track - 1 }), { disabled: track <= lo, testid: "track-up" })}
      {row(t("timeline.track.down"), () => act({ a: "move", track, to: track + 1 }), { disabled: track >= hi, testid: "track-down" })}
      {row(t("timeline.track.addVideo"), () => act({ a: "add", kind: "video" }), { testid: "track-add-video" })}
      {row(t("timeline.track.addAudio"), () => act({ a: "add", kind: "audio" }), { testid: "track-add-audio" })}
      {row(t("timeline.track.remove"), () => act({ a: "remove", track }), { danger: true, disabled: lockedNote, testid: "track-remove" })}
      {lockedNote && <p className="menu-status tl-menu-note">{t("timeline.track.removeLocked")}</p>}
    </>;
  }
  return (
    <div ref={box} className="menu-pop tl-menu" role="menu" aria-label={menuLabel}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden" }} onKeyDown={onKey} data-testid="track-menu">
      {body}
    </div>
  );
}
