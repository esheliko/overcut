import type { Op, Sequence } from "@app/engine-client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BACKGROUND_MODES, BACKGROUND_SWATCHES, FPS_CHOICES, QUALITIES, SHAPES, backgroundOf, canvasDialogOps, choiceOf, fpsLabel, frameRateOf, hexOf, resolutionOf, rgbOf, type BackgroundChoice, type CanvasChoice } from "./canvas";
import { rememberFocus } from "./a11y/restoreFocus";
import { useI18n } from "./i18n";
import { Icon } from "./icons";
import { useReturnFocus } from "./a11y/returnFocus";
import { useBackClose } from "./layout/backStack";
import { NetworkLog } from "./privacy/NetworkLog";

/** A modal `<dialog>` that closes on Esc and starts focused on its title. Shared by the canvas settings and the confirmations. */
export function Modal({ title, titleId, testId, onClose, children, role }: { title: string; titleId: string; testId: string; onClose(): void; children: ReactNode; role?: "alertdialog" }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const head = useRef<HTMLHeadingElement>(null);
  useReturnFocus();
  useBackClose(true, onClose); // Back / swipe-back closes the dialog before anything else
  useEffect(() => {
    const d = ref.current;
    const back = rememberFocus();
    if (d && !d.open) d.showModal();
    head.current?.focus({ preventScroll: true });
    return () => { d?.close(); back(); };
  }, []);
  return (
    <dialog ref={ref} className="pj-dialog" role={role} aria-labelledby={titleId} data-testid={testId} onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <header className="export-head">
        <h2 id={titleId} ref={head} tabIndex={-1}>{title}</h2>
        <button className="icon-btn" onClick={onClose} aria-label={t("export.close")}><Icon name="close" size={20} /></button>
      </header>
      <div className="export-body">{children}</div>
    </dialog>
  );
}

/** "New project" / "Open project": replacing the project asks first when the open one has changes that were never saved to a file. */
/** `danger`: the confirm button throws something away (e.g. New project replaces the open one), so it gets the danger style, not the safe one. */
export function ConfirmDialog({ title, body, confirm, onConfirm, onClose, busy, danger = false }: { title: string; body: string; confirm: string; onConfirm(): void; onClose(): void; busy?: boolean; danger?: boolean }) {
  const { t } = useI18n();
  return (
    <Modal title={title} titleId="confirm-title" testId="confirm-dialog" onClose={onClose} role="alertdialog">
      <p className="export-note">{body}</p>
      <div className="export-actions">
        <button className="export-secondary" onClick={onClose} data-testid="confirm-cancel">{t("project.cancel")}</button>
        <button className={danger ? "export-go confirm-danger" : "export-go"} onClick={onConfirm} disabled={busy} data-testid="confirm-ok">{confirm}</button>
      </div>
    </Modal>
  );
}

/**
 * The project canvas: shape, resolution, frame rate. "Match first clip" is the zero-question default (the first import sets the size and rate);
 * choosing a shape or rate here fixes it. Applying is one `set_canvas` edit, so Undo takes it back.
 */
export function CanvasDialog({ sequence, hasPicture, onApply, onClose }: { sequence: Sequence; hasPicture: boolean; onApply(ops: Op[]): void; onClose(): void }) {
  const { t } = useI18n();
  const [c, setC] = useState<CanvasChoice>(() => choiceOf(sequence));
  const edit = (patch: Partial<CanvasChoice>) => setC((cur) => ({ ...cur, ...patch }));
  const [bg, setBg] = useState<BackgroundChoice>(() => backgroundOf(sequence));
  const editBg = (patch: Partial<BackgroundChoice>) => setBg((cur) => ({ ...cur, ...patch }));
  const ops = canvasDialogOps(sequence, c, bg);
  const size = resolutionOf(c, sequence.resolution);
  const rate = frameRateOf(c, sequence.frame_rate);
  // With a picture in the project "match" would have to look at that picture again: offer it only where it is what the project already does.
  const matchOk = !hasPicture || c.shape === "match";
  const matchRateOk = !hasPicture || c.fps === "match";
  const shapes = useMemo(() => SHAPES.map((s) => s.id), []);
  const sizeText = `${size.width} × ${size.height}`;
  const num = (v: string): number => (v === "" ? 0 : Number(v.replace(/\D/g, "")) || 0);
  return (
    <Modal title={t("canvas.title")} titleId="canvas-title" testId="canvas-dialog" onClose={onClose}>
      {/* The shape in one tap (UX r15 PHONE-10): a tile per ratio; tapping one applies it at once (Undo takes it back). The fields below are for the rest. */}
      <div className="ratio-row" role="group" aria-label={t("canvas.shape")} data-testid="canvas-ratios">
        {SHAPES.map((sh) => (
          <button key={sh.id} type="button" className="ratio-tile" aria-pressed={c.shape === sh.id} aria-label={t(`canvas.shape.${sh.id}`)} data-testid={`canvas-ratio-${sh.id.replace(":", "x")}`}
            onClick={() => { const next = canvasDialogOps(sequence, { ...c, shape: sh.id }, bg); if (next.length > 0) onApply(next); else onClose(); }}>
            <span className="ratio-glyph" aria-hidden="true" style={{ aspectRatio: `${sh.w} / ${sh.h}`, inlineSize: sh.w >= sh.h ? 28 : undefined, blockSize: sh.w < sh.h ? 28 : undefined }} />
            <span>{sh.id}</span>
          </button>
        ))}
      </div>
      <div className="export-fields">
        <label>{t("canvas.shape")}
          <select value={c.shape} onChange={(e) => edit({ shape: e.target.value })} data-testid="canvas-shape">
            <option value="match" disabled={!matchOk}>{t("canvas.match")}</option>
            {shapes.map((id) => <option key={id} value={id}>{t(`canvas.shape.${id}`)}</option>)}
            <option value="custom">{t("canvas.shape.custom")}</option>
          </select>
        </label>
        {c.shape !== "custom" && c.shape !== "match" && (
          <label>{t("canvas.resolution")}
            <select value={c.short} onChange={(e) => edit({ short: Number(e.target.value) })} data-testid="canvas-resolution">
              {QUALITIES.map((q) => <option key={q} value={q}>{t(`canvas.res.${q}`)}</option>)}
            </select>
          </label>
        )}
        {c.shape === "custom" && (
          <>
            <label>{t("canvas.width")}
              <input inputMode="numeric" value={c.custom.width || ""} onChange={(e) => edit({ custom: { ...c.custom, width: num(e.target.value) } })} data-testid="canvas-width" />
            </label>
            <label>{t("canvas.height")}
              <input inputMode="numeric" value={c.custom.height || ""} onChange={(e) => edit({ custom: { ...c.custom, height: num(e.target.value) } })} data-testid="canvas-height" />
            </label>
          </>
        )}
        <label>{t("canvas.fps")}
          <select value={c.fps} onChange={(e) => edit({ fps: e.target.value })} data-testid="canvas-fps">
            <option value="match" disabled={!matchRateOk}>{t("canvas.match")}</option>
            {FPS_CHOICES.map((f) => <option key={f} value={String(f)}>{t("canvas.fps.value", { fps: f })}</option>)}
            {c.fps === "custom" && <option value="custom">{t("canvas.fps.value", { fps: fpsLabel(sequence.frame_rate) })}</option>}
          </select>
        </label>
      </div>
      <div className="export-fields bg-fields" role="group" aria-label={t("canvas.bg")}>
        <label>{t("canvas.bg")}
          <select value={bg.mode} onChange={(e) => editBg({ mode: e.target.value as BackgroundChoice["mode"] })} data-testid="canvas-bg-mode">
            {BACKGROUND_MODES.map((m) => <option key={m} value={m}>{t(`canvas.bg.${m}`)}</option>)}
          </select>
        </label>
        {bg.mode === "blur" && (
          <label>{t("canvas.bg.amount", { value: bg.blur })}
            <input type="range" min={0} max={100} step={1} value={bg.blur} className="bg-range" onChange={(e) => editBg({ blur: Number(e.target.value) })} data-testid="canvas-bg-blur" />
          </label>
        )}
      </div>
      {bg.mode === "colour" && (
        <div className="bg-colours" role="radiogroup" aria-label={t("canvas.bg.colour")} data-testid="canvas-bg-colours">
          {BACKGROUND_SWATCHES.map((hex) => (
            <button key={hex} type="button" className="swatch" role="radio" aria-checked={hexOf(bg.colour) === hex} data-checked={hexOf(bg.colour) === hex} aria-label={t("canvas.bg.pick", { colour: hex })} data-testid={`canvas-bg-colour-${hex.slice(1)}`} onClick={() => editBg({ colour: rgbOf(hex)! })}>
              <span className="swatch-dot" style={{ background: hex }} />
            </button>
          ))}
          <label className="bg-custom">{t("canvas.bg.custom")}
            <input type="color" value={hexOf(bg.colour)} onChange={(e) => { const rgb = rgbOf(e.target.value); if (rgb) editBg({ colour: rgb }); }} data-testid="canvas-bg-custom" />
          </label>
        </div>
      )}
      <p className="export-note" data-testid="canvas-bg-note">{t("canvas.bg.note")}</p>
      <p className="export-estimate" data-testid="canvas-result" aria-live="polite">
        {c.shape === "match" ? t("canvas.result.match", { size: sizeText, fps: fpsLabel(rate) }) : t("canvas.result", { size: sizeText, fps: fpsLabel(rate) })}
      </p>
      <div className="export-actions export-footer">
        <button className="export-secondary" onClick={onClose} data-testid="canvas-cancel">{t("canvas.cancel")}</button>
        <button className="export-go" disabled={ops.length === 0} onClick={() => onApply(ops)} data-testid="canvas-apply">{t("canvas.apply")}</button>
      </div>
    </Modal>
  );
}

/** App menu > Privacy: the visible network log (XT-06). */
export function PrivacyDialog({ onClose }: { onClose(): void }) {
  const { t } = useI18n();
  return (
    <Modal title={t("net.title")} titleId="privacy-title" testId="privacy-dialog" onClose={onClose}>
      <p className="export-note">{t("net.intro")}</p>
      <NetworkLog />
    </Modal>
  );
}
