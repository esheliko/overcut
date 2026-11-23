import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "../icons";
import { useI18n } from "../i18n";

/** A modal sheet: centered dialog on desktop, full screen on a phone (the same shell as the export dialog). Esc and the X close it. */
export function Sheet({ title, onClose, children, testid }: { title: string; onClose(): void; children: ReactNode; testid: string }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog ref={ref} className="export-dialog sheet" aria-labelledby={id} data-testid={testid} onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <header className="export-head">
        <h2 id={id}>{title}</h2>
        <button className="icon-btn" onClick={onClose} aria-label={t("sheet.close")} data-testid={`${testid}-close`}><Icon name="close" size={20} /></button>
      </header>
      <div className="export-body">{children}</div>
    </dialog>
  );
}
