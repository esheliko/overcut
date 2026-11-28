import { useEffect, useRef, useState } from "react";
import { useI18n } from "./i18n";
import { AccentPicker } from "./AppearanceInstall";
import { Icon } from "./icons";
import { THEME_PREFS, resolveTheme, type ThemePref } from "./theme/theme";

/** The theme button shows what the theme IS (UX r15 D1, customer: "I did not recognise it"): a sun on a light screen, a moon on a dark one; never an abstract half circle. */
export const themeIcon = (pref: ThemePref): "sun" | "moon" => (resolveTheme(pref) === "light" ? "sun" : "moon");

/**
 * F3 (theme menu): the top-bar theme button opens a small menu of System, Dark, Light and High contrast, instead of cycling
 * through them. Keyboard reachable (Tab, Enter/Space), Esc or a click outside closes it and returns focus to the button.
 */
export function ThemeMenu({ pref, onPick }: { pref: ThemePref; onPick(p: ThemePref): void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const name = t(`theme.${pref}`);

  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); button.current?.focus(); } };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  return (
    <div className="theme-menu" ref={ref}>
      <button ref={button} className="icon-btn" aria-label={t("theme.change", { theme: name })} aria-haspopup="menu" aria-expanded={open} title={t("theme.label")} onClick={() => setOpen((o) => !o)} data-testid="theme-toggle"><Icon name={themeIcon(pref)} size={20} /></button>
      {open && (
        <div className="menu-pop theme-pop" role="menu" aria-label={t("theme.label")} data-testid="theme-menu">
          {THEME_PREFS.map((p) => (
            <button key={p} className="menu-row" role="menuitemradio" aria-checked={p === pref} data-testid={`theme-${p}`} onClick={() => { setOpen(false); onPick(p); button.current?.focus(); }}>
              <span className="menu-check" aria-hidden="true">{p === pref && <Icon name="check" size={16} />}</span>
              <span>{t(`theme.${p}`)}</span>
            </button>
          ))}
          <div className="menu-sep" role="separator" />
          <AccentPicker />
        </div>
      )}
    </div>
  );
}
