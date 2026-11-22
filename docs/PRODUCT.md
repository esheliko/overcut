# Product

## Vision
Anyone, on any device, can make a great video in minutes and a professional one in hours, with a tool that is free, fast, private and never in their way.

## The problem with the incumbent
CapCut is popular because it is quick and rich, but users widely report that it is a funnel: features moving behind a subscription over time, watermarks or login walls on some export paths, projects tied to an account and cloud, desktop and mobile apps that differ, and broad content-licence terms. (Check the current facts before using any of this in public marketing; our plan does not depend on them.) People who only want to cut a clip put up with all of it. Open-source editors (Kdenlive, Shotcut, OpenShot, Olive) are free but slow to learn, desktop-only and weak at the short-form and caption-heavy workflow that most creators now have.

## Positioning
**Overcut = CapCut's speed and feature set + a pro editor's depth + open-source freedom, on every screen.**

| | CapCut | Open-source desktop editors | Overcut |
|---|---|---|---|
| Price / watermark | free tier with gated features | free | free, no gates, no watermark, ever |
| Account needed | yes for many features | no | no |
| Where media lives | device + vendor cloud | device | device (optional bring-your-own storage) |
| Platforms | mobile, desktop, web (different apps) | desktop only | one codebase: web/PWA, Windows, macOS, Linux, iOS, Android |
| Short-form workflow (captions, reframe, templates) | excellent | weak | first-class |
| AI tools | cloud, often gated | few | on-device, free, opt-in model downloads |
| Learning curve | low | high | low by default, depth on demand |

## Principles (these settle arguments)
1. **Free means free.** No watermark, paywalled feature, account wall, ad, dark pattern or "pro" tier. Costs are paid by being a lean open project (no servers to run), donations and sponsors.
2. **Fast is a feature.** Open in a second, scrub instantly, never block the UI. Budgets in `PERFORMANCE.md` are release gates, not aspirations.
3. **Local-first and private.** Projects and media never leave the device unless the user shares them. No telemetry by default. AI runs on-device.
4. **Every screen is first-class.** The phone layout is designed, not shrunk from the desktop. Touch, mouse, keyboard, stylus and controller all work.
5. **Simple by default, deep on demand.** The first project needs no tutorial; keyframes, curves, scopes and scripting appear when asked for. Progressive disclosure, not modes.
6. **Never lose work.** Autosave on every operation, crash recovery, unlimited undo, non-destructive edits, open documented file format.
7. **Complete.** A creator should not need a second app for captions, audio cleanup, color, reframing or export presets.
8. **Open and extensible.** Open format, open plugin API for effects/transitions/templates, headless CLI.

## Who it is for
- **Short-form creators** (phone-first): fast cuts, captions, templates, reframing 9:16/1:1/16:9, trending-style effects, one-tap export to platform presets.
- **Students, teachers, small businesses**: screen recordings, explainers, presentations, subtitles in many languages, no budget for subscriptions.
- **Prosumers / YouTubers** (desktop): multi-track, keyframes, proper audio, color, 4K, long timelines, proxies, shortcuts.
- **Privacy- or cost-constrained users**: journalists, NGOs, regions with poor connectivity or pricing: offline, no account, no upload.

## Non-goals (for 1.0)
- A hosted cloud service, social network or marketplace with payments.
- Hollywood-grade finishing (full HDR grading suites, Fairlight-class audio, VFX compositing node graph, multicam broadcast switching). Seams are left for them, not built.
- Generative cloud AI (text-to-video, voice cloning). Possible later as optional, clearly-labelled, bring-your-own-key integrations; never required.
- Importing CapCut project files (proprietary, unstable). Import of common interchange formats (EDL/FCPXML/OTIO) is a P2.

## Success measures
- **Activation**: a new user imports, trims, adds a caption and exports in under 3 minutes without help (usability test, 8 of 10 succeed).
- **Speed**: all budgets in `PERFORMANCE.md` met on the reference devices.
- **Reliability**: crash-free sessions >= 99.5% (opt-in crash reports), zero known data-loss bugs at release.
- **Reach**: runs on the platforms in `ARCHITECTURE.md` with feature parity except where the OS forbids it (documented).
- **Trust**: no network request at runtime except update checks and user-initiated actions; verifiable in the open code.
- **Community** (post-1.0): effects/templates contributed by others; translation coverage; contributors per release.

## Honest constraints
"Completely free" still has costs: domain, code-signing (Apple Developer Program, Google Play fee, Windows signing), CI minutes, hosting of the static site and model files. The plan keeps these tiny (no backend, static hosting, GitHub Releases, open-source signing programs) and lists them in ADR 0009 and 0011 so they are a conscious decision. Codec patents (H.264/HEVC/AAC) are handled by using OS/browser/hardware codecs rather than shipping encoders (ADR 0004).
