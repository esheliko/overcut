import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import en from "./en.json";
import { createTranslator, DEFAULT_LOCALE, negotiateLocale, pseudoLocalize, type Catalog, type Translator, type Values } from "./core";

export const EN: Catalog = en;
/** Shipped catalogs. Real translations land here as `<tag>.json` imports (UX-07, M9). */
const CATALOGS: Record<string, Catalog> = {
  en: EN,
  "en-XA": pseudoLocalize(EN, "accent"),
  "en-XB": pseudoLocalize(EN, "bidi"),
};
/** Pseudo-locales are for testing layout; they are never picked by negotiation, only by an explicit override. */
export const LOCALES = Object.keys(CATALOGS);
const NEGOTIABLE = LOCALES.filter((l) => !l.startsWith("en-X"));
const STORE_KEY = "overcut.locale";

function readOverride(): string | null {
  try {
    const v = localStorage.getItem(STORE_KEY);
    return v && v in CATALOGS ? v : null;
  } catch {
    return null;
  }
}

/** Override (persisted locally) first, then the browser's language list, then English. */
export function initialLocale(): string {
  return readOverride() ?? negotiateLocale(typeof navigator === "undefined" ? [] : navigator.languages ?? [navigator.language], NEGOTIABLE);
}

export function applyLocale(locale: string, root: HTMLElement = document.documentElement): void {
  const tr = createTranslator(locale, CATALOGS[locale] ?? EN, EN);
  root.lang = locale;
  root.dir = tr.dir;
}

type Ctx = Translator & { setLocale: (l: string | null) => void };
const I18nContext = createContext<Ctx>({ ...createTranslator(DEFAULT_LOCALE, EN), setLocale: () => undefined });

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLoc] = useState(initialLocale);
  useEffect(() => applyLocale(locale), [locale]);
  const setLocale = useCallback((l: string | null) => {
    try {
      if (l) localStorage.setItem(STORE_KEY, l);
      else localStorage.removeItem(STORE_KEY);
    } catch { /* private mode: the choice just lasts this session */ }
    setLoc(l ?? initialLocale());
  }, []);
  const value = useMemo<Ctx>(() => ({ ...createTranslator(locale, CATALOGS[locale] ?? EN, EN), setLocale }), [locale, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): Ctx {
  return useContext(I18nContext);
}
export type { Values };
