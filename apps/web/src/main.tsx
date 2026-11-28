import { StrictMode, Suspense, createElement, lazy } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyLocale, initialLocale, I18nProvider } from "./i18n";
import { startNetworkCapture } from "./privacy/networkLog";
import { watchInstallPrompt } from "./install";
import { ErrorBoundary, ForcedError } from "./errorScreen/ErrorScreen";
import { applyAccent, applyTheme, loadAccent, loadPref, redrawWhenFontsLoad } from "./theme/theme";
import "./theme/fonts.css";
import "./theme/tokens.css";
import "./styles.css";
import "./interaction-states.css";

// Set theme, language and direction before the first paint so there is no flash of the wrong theme.
applyTheme(loadPref());
applyAccent(loadAccent());
redrawWhenFontsLoad(); // the timeline canvas draws once with the fallback font, then again as soon as Inter is in (same width everywhere)
watchInstallPrompt(); // the browser fires `beforeinstallprompt` early: keep it until the menu can offer it
applyLocale(initialLocale());
startNetworkCapture(); // the visible network log (Privacy menu, /diagnostics)

// `/#timeline-bench` opens the S8 benchmark page (lazy chunk, not linked from the UI).
const Diagnostics = lazy(() => import("./diagnostics/Diagnostics"));
const onDiagnostics = location.pathname.replace(/\/+$/, "") === "/diagnostics";
const bench = location.hash.startsWith("#timeline-bench") ? lazy(() => import("./TimelineBench").then((m) => ({ default: m.TimelineBench }))) : null;

// `/#export-harness` drives the export pipeline on a synthetic project (M1-022; the real dialog is M1-035).
const harness = location.hash === "#export-harness" ? lazy(() => import("./ExportHarness").then((m) => ({ default: m.ExportHarness }))) : null;

// Test-only: `?e2e&force-error=<ms>` makes the app fail after <ms> so the error screen can be checked (tests/smoke/error-screen.spec.ts).
const params = new URLSearchParams(location.search);
const forced = params.has("e2e") && params.has("force-error") ? Number(params.get("force-error")) || 0 : null;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {bench ? <Suspense fallback={null}>{createElement(bench)}</Suspense> : harness ? <Suspense fallback={null}>{createElement(harness)}</Suspense> : <I18nProvider>{onDiagnostics ? <Suspense fallback={null}><Diagnostics /></Suspense> : <ErrorBoundary>{forced !== null && <ForcedError delay={forced} />}<App /></ErrorBoundary>}</I18nProvider>}
  </StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD && !("__TAURI_INTERNALS__" in window)) {
  addEventListener("load", () => void navigator.serviceWorker.register("/sw.js").then(cacheLoadedAssets).catch(() => undefined));
}

/**
 * First visit: files loaded before the service worker took control (the JS chunks, the engine .wasm) never passed through it, so they are
 * not in its cache and the app would not start offline. Once it controls the page, re-request each same-origin file the page has loaded or
 * loads later (served from the HTTP cache, no new download) so the worker stores it. Best effort; offline use is checked by tests/smoke/network.spec.ts.
 */
async function cacheLoadedAssets(): Promise<void> {
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) await new Promise<void>((done) => navigator.serviceWorker.addEventListener("controllerchange", () => done(), { once: true }));
  const seen = new Set<string>();
  // buffered: also the files loaded before this point; the engine chunks arrive a little later, so keep observing
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (new URL(e.name).origin !== location.origin || seen.has(e.name)) continue;
      seen.add(e.name);
      void fetch(e.name).catch(() => undefined);
    }
  }).observe({ type: "resource", buffered: true });
}
