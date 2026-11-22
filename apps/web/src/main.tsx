import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// Two pages, no router needed: the editor, and the device check at /diagnostics.
const Diagnostics = lazy(() => import("./diagnostics/Diagnostics"));
const onDiagnostics = location.pathname.replace(/\/+$/, "") === "/diagnostics";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {onDiagnostics ? <Suspense fallback={null}><Diagnostics /></Suspense> : <App />}
  </StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD && !("__TAURI_INTERNALS__" in window)) {
  addEventListener("load", () => void navigator.serviceWorker.register("/sw.js").catch(() => undefined));
}
