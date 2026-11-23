# Theming, i18n and accessibility primitives (M1-036; FEATURES UX-06, UX-07)

## Behaviour
- **Themes**: `dark` (default, the original shell look), `light`, `high-contrast`. `<html data-theme>` selects one. The user's choice is `system | dark | light | high-contrast`, persisted in `localStorage["overcut.theme"]`; `system` follows `prefers-contrast: more` (then high-contrast) and `prefers-color-scheme: light`, live. Applied in `main.tsx` before first paint. The top-bar theme button cycles the choice and announces it.
- **Tokens** (`apps/web/src/theme/tokens.css`, the single source of truth): colour roles (`--bg --surface(-2,-3) --fg --muted --accent --accent-ink --accent-soft --danger --ok --line --line-strong --stage --stage-fg --clip`), spacing `--space-1..6`, radius, type scale `--text-*`, fonts, motion `--dur-*` (all `0s` under `prefers-reduced-motion`), focus ring `--focus-ring(-width/-offset)`. Components use roles, never colour literals (a test enforces it for `styles.css`). The preview stage stays dark in every theme (it stands for video).
- **Canvas code** reads tokens with `theme/tokens.ts` (`readToken`, `readColors`, `readDurationMs`) and redraws on `onThemeChange`.
- **i18n**: ICU MessageFormat via `intl-messageformat` (BSD-3). English catalog `i18n/en.json` (flat keys); components use `const { t } = useI18n(); t("key", { values })`. Locale = stored override (`overcut.locale`), else negotiated from `navigator.languages` against shipped catalogs (RFC 4647 lookup), else `en`. `<html lang dir>` set from the locale; a missing key falls back to English, then to the key. Pseudo-locales `en-XA` (accented, +30%) and `en-XB` (right to left) exist for layout testing; only reachable through the stored override.
- **RTL**: shell CSS uses logical properties; the grid areas mirror. Deliberately LTR in every locale: the timeline time axis, the transport controls and the timecode (as in other editors).
- **a11y primitives** (`apps/web/src/a11y/`): `.visually-hidden`/`<VisuallyHidden>`, focus-ring tokens, `announce()` live-region announcer (polite/assertive; repeats identical messages), `useRovingTabindex` + `nextRovingIndex` (RTL aware; used by the Details tabs).

## Rules for new UI
- No user-visible English in components: add the string to `en.json` and use `t()`. `tests/unit/i18n-hardcoded.test.ts` fails on JSX text and on `aria-label/title/placeholder/alt` literals.
- New colour pairs: add the pair to `PAIRS` in `tests/unit/theme-contrast.test.ts`; text needs 4.5:1, non-text 3:1.
- Use logical CSS (`margin-inline-start`, `inset-inline-end`, ...); physical left/right only inside the LTR islands listed in the test.
- Dev tools/diagnostic pages are UI too and follow the same rules.

## Data / edge cases
- Storage failures (private mode) are swallowed; the choice then lasts the session. Unknown stored values fall back to `system` / negotiated locale.
- Dark theme changes from before: `--stage-fg` 0.45 -> 0.5 alpha (the old value was 4.2:1, below AA).

## Test plan
`theme-contrast.test.ts` (WCAG ratios per theme parsed from the CSS, no colour literals, logical CSS), `i18n.test.ts` (ICU plurals incl. Polish/Arabic, negotiation, direction, pseudo-locales, catalog keys used/defined), `i18n-hardcoded.test.ts`, `a11y.test.ts`, `theme.test.ts`; smoke: theme follow/override/persist, lang/dir and RTL mirroring, no overflow.

## Not done (later)
Real translations and the language picker UI (M9, UX-07); a runtime catalog loader per locale; the S8 canvas timeline adopting `readColors`; M1-006 diagnostics page migrating its strings.

## Top bar below 480 px
Logo | project name (flexible, ellipsis, tap to rename) | Export (always visible) | "..." menu. The theme toggle and the engine status (the status chip is visually hidden, still in the DOM and shown again if the engine fails) move into the menu. 44 px targets, no horizontal scroll at 320 px. Screenshots: `docs/features/img/topbar-phone-*.png`.
