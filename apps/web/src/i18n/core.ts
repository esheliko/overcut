import { IntlMessageFormat } from "intl-messageformat";

/** Flat message catalog: key -> ICU MessageFormat string. */
export type Catalog = Record<string, string>;
export type Values = Record<string, string | number>;
export type Dir = "ltr" | "rtl";

export const DEFAULT_LOCALE = "en";
const RTL_SCRIPTS = new Set(["Arab", "Hebr", "Thaa", "Syrc", "Nkoo", "Adlm", "Rohg", "Mand", "Samr"]);
const RTL_LANGS = new Set(["ar", "he", "fa", "ur", "ps", "sd", "yi", "dv", "ug", "ckb"]);

/** Text direction of a locale: from its (likely) script, else from a list of RTL languages. */
export function directionOf(locale: string): Dir {
  if (/-XB$/i.test(locale)) return "rtl"; // pseudo-bidi test locale
  try {
    const l = new Intl.Locale(locale).maximize();
    if (l.script) return RTL_SCRIPTS.has(l.script) ? "rtl" : "ltr";
    return RTL_LANGS.has(l.language) ? "rtl" : "ltr";
  } catch {
    return "ltr";
  }
}

/**
 * Pick the best available locale for the user's ordered preferences (RFC 4647 "lookup":
 * exact match, then progressively truncated tags, then any regional variant of the language).
 */
export function negotiateLocale(requested: readonly string[], available: readonly string[], fallback = DEFAULT_LOCALE): string {
  const have = new Map(available.map((a) => [a.toLowerCase(), a]));
  for (const req of requested) {
    const parts = req.replace(/_/g, "-").toLowerCase().split("-").filter(Boolean);
    for (let n = parts.length; n > 0; n--) {
      const hit = have.get(parts.slice(0, n).join("-"));
      if (hit) return hit;
    }
    const lang = parts[0];
    if (lang) {
      const variant = available.find((a) => a.toLowerCase().startsWith(`${lang}-`));
      if (variant) return variant;
    }
  }
  return fallback;
}

export type Translator = {
  locale: string;
  dir: Dir;
  /** Format message `key`. A missing key falls back to the default locale, then to the key itself. */
  t: (key: string, values?: Values) => string;
};

/** Build a translator for one locale. Formatters are cached per key. */
export function createTranslator(locale: string, catalog: Catalog, fallback: Catalog = {}): Translator {
  const cache = new Map<string, IntlMessageFormat>();
  const t = (key: string, values?: Values): string => {
    const source = catalog[key] ?? fallback[key];
    if (source === undefined) return key;
    let fmt = cache.get(key);
    if (!fmt) {
      try {
        fmt = new IntlMessageFormat(source, catalog[key] !== undefined ? locale : DEFAULT_LOCALE);
      } catch {
        return source; // a broken translation must never take the UI down
      }
      cache.set(key, fmt);
    }
    try {
      return String(fmt.format(values));
    } catch {
      return source;
    }
  };
  return { locale, dir: directionOf(locale), t };
}

/** Pseudo-locales for testing layout: "en-XA" (accents, ~30% longer) and "en-XB" (bidi, renders right to left). */
export function pseudoLocalize(catalog: Catalog, kind: "accent" | "bidi"): Catalog {
  const map: Record<string, string> = { a: "á", e: "é", i: "í", o: "ö", u: "ü", c: "ç", n: "ñ", s: "š", y: "ý", A: "Å", E: "É", I: "Î", O: "Ö", U: "Ü" };
  const out: Catalog = {};
  for (const [k, v] of Object.entries(catalog)) out[k] = transformText(v, (s) => (kind === "accent" ? s.replace(/[a-zA-Z]/g, (c) => map[c] ?? c) + "~".repeat(Math.ceil(s.length * 0.3)) : `‮${s}‬`));
  return out;
}

/** Apply `fn` to literal text only: top level and plural/select branches, never argument syntax like `{n, plural, one`. */
function transformText(msg: string, fn: (s: string) => string): string {
  let out = "";
  let depth = 0;
  let lit = "";
  const flush = () => {
    out += depth === 1 ? lit : fn(lit);
    lit = "";
  };
  for (const ch of msg) {
    if (ch === "{" || ch === "}") {
      if (lit) flush();
      depth += ch === "{" ? 1 : -1;
      out += ch;
    } else lit += ch;
  }
  if (lit) flush();
  return out;
}
