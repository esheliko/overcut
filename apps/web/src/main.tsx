import { StrictMode, Suspense, createElement, lazy } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyLocale, initialLocale, I18nProvider } from "./i18n";
import { applyTheme, loadPref } from "./theme/theme";
import "./theme/tokens.css";
import "./styles.css";

// Set theme, language and direction before the first paint so there is no flash of the wrong theme.
applyTheme(loadPref());
applyLocale(initialLocale());

// `/#timeline-bench` opens the S8 benchmark page (lazy chunk, not linked from the UI).
const bench = location.hash.startsWith("#timeline-bench") ? lazy(() => import("./TimelineBench").then((m) => ({ default: m.TimelineBench }))) : null;

// `/#export-harness` drives the export pipeline on a synthetic project (M1-022; the real dialog is M1-035).
const harness = location.hash === "#export-harness" ? lazy(() => import("./ExportHarness").then((m) => ({ default: m.ExportHarness }))) : null;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {bench ? <Suspense fallback={null}>{createElement(bench)}</Suspense> : harness ? <Suspense fallback={null}>{createElement(harness)}</Suspense> : <I18nProvider><App /></I18nProvider>}
  </StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD && !("__TAURI_INTERNALS__" in window)) {
  addEventListener("load", () => void navigator.serviceWorker.register("/sw.js").catch(() => undefined));
}
