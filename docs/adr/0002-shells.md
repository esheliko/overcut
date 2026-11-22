# 0002 PWA + Tauri 2 shells, one UI
**Status**: proposed

**Context.** One team must ship to browsers, Windows, macOS, Linux, iOS and Android. Electron is heavy; Flutter/React Native would fork the UI from the web; fully native UIs multiply work.

**Decision.** One web UI (React + Vite). Browser users get it as an installable PWA. Desktop and mobile apps are **Tauri 2** shells (system WebView + Rust process) hosting the same UI and exposing the native engine through commands. Native-only capabilities (FFmpeg, hardware encoders, file system) are added behind the `Engine` interface so the UI is identical.

**Consequences.** (+) tiny apps, one UI codebase, Rust on both sides, no Chromium bundled. (-) WebView differences per OS (WebCodecs/WebGPU availability, e.g. WKWebView, Android System WebView) and Tauri mobile maturity: spike S5 maps them; native plugins (Swift/Kotlin) are the escape hatch for decode/encode. The PWA remains the guaranteed mobile path.
