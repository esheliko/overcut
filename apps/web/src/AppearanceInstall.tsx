/** Menu pieces for the accent picker (UX-05) and the install affordance (PM-12). Kept out of App.tsx; both fail soft. */
import { useEffect, useId, useRef, useState } from "react";
import { announce } from "./a11y/announcer";
import { useI18n } from "./i18n";
import { Icon } from "./icons";
import { useInstall } from "./install";
import { loadScrubPrep, saveScrubPrep } from "./preview/strip/setting";
import { ACCENTS, ACCENT_SWATCH, applyAccent, loadAccent, saveAccent, type Accent } from "./theme/theme";

/** A radio group of colour swatches (44 px targets). The choice is stored on this device only. */
export function AccentPicker() {
  const { t } = useI18n();
  const [accent, setAccent] = useState<Accent>(loadAccent);
  const pick = (a: Accent) => {
    setAccent(a);
    saveAccent(a);
    applyAccent(a);
    announce(t("accent.changed", { accent: t(`accent.${a}`) }));
  };
  return (
    <div className="menu-accent" role="radiogroup" aria-label={t("accent.label")} data-testid="accent-picker">
      <span className="menu-accent-title" aria-hidden="true">{t("accent.label")}</span>
      <div className="menu-accent-row">
        {ACCENTS.map((a) => (
          <button key={a} role="radio" aria-checked={accent === a} aria-label={t(`accent.${a}`)} title={t(`accent.${a}`)} className="swatch" data-testid={`accent-${a}`} data-checked={accent === a} onClick={() => pick(a)}>
            <span className="swatch-dot" style={{ background: ACCENT_SWATCH[a] }} aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  );
}

/** "Install app" (browser prompt) or "Add to Home Screen" (iOS how-to); renders nothing when neither applies. */
export function InstallItem({ desktopApp, onDone }: { desktopApp: boolean; onDone(): void }) {
  const { t } = useI18n();
  const { kind, prompt } = useInstall(desktopApp);
  const [how, setHow] = useState(false);
  if (kind === null) return null;
  return (
    <>
      <button className="menu-row" role="menuitem" data-testid="menu-install" onClick={() => {
        if (kind === "ios") { setHow(true); return; }
        onDone();
        void prompt().then((ok) => { if (ok) announce(t("install.done")); }).catch(() => undefined);
      }}>
        <Icon name="export" size={20} /><span>{t(kind === "ios" ? "install.ios.item" : "install.item")}</span>
      </button>
      {how && <IosHowTo onClose={() => { setHow(false); onDone(); }} />}
    </>
  );
}

function IosHowTo({ onClose }: { onClose(): void }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog ref={ref} className="install-dialog" aria-labelledby="install-title" data-testid="install-howto" onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <h2 id="install-title">{t("install.ios.title")}</h2>
      <ol>
        <li>{t("install.ios.step1")}</li>
        <li>{t("install.ios.step2")}</li>
        <li>{t("install.ios.step3")}</li>
      </ol>
      <p className="export-note">{t("install.ios.note")}</p>
      <button className="primary" onClick={onClose} data-testid="install-close">{t("install.ios.close")}</button>
    </dialog>
  );
}

/** "Smooth scrubbing": the background preparation of small stand-in pictures for slow-seeking clips (on by default; off stops the work and the stand-ins). */
export function ScrubPrepItem() {
  const { t } = useI18n();
  const [on, setOn] = useState(loadScrubPrep);
  const hintId = useId();
  return (
    <button className="menu-row menu-switch" role="menuitemcheckbox" aria-checked={on} aria-describedby={hintId} data-testid="menu-scrub-prep" onClick={() => { const v = !on; setOn(v); saveScrubPrep(v); announce(t(v ? "scrub.on" : "scrub.off")); }}>
      <Icon name="film" size={20} />
      <span className="menu-text">
        <span className="menu-line"><span>{t("scrub.menu.label")}</span><span className="menu-state">{t(on ? "scrub.menu.on" : "scrub.menu.off")}</span></span>
        <span className="menu-hint" id={hintId}>{t("scrub.menu.hint")}</span>
      </span>
    </button>
  );
}
