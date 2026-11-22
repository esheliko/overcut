# Feature list

**Legend.** *Pri*: P0 required to call 1.0 a CapCut alternative; P1 expected by 1.0; P2 after 1.0; P3 idea. *M*: milestone that ships it ([ROADMAP.md](ROADMAP.md)). *CC*: relation to CapCut's equivalent: `=` we match it, `+` we go beyond it, `~` we ship a subset first. Status of every row is **planned** until its `docs/features/<id>.md` exists and the feature is merged. IDs are permanent.

## 1. Project and media (PM)
| ID | Feature | Pri | M | CC | Notes |
|---|---|---|---|---|---|
| PM-01 | New project with canvas presets (9:16, 1:1, 4:5, 16:9, 21:9, custom), frame rate, resolution | P0 | M1 | = | Changeable later; clips adapt (see TL-24) |
| PM-02 | Import video/audio/images via picker, drag and drop, paste, share-sheet / "open with" | P0 | M1 | = | Camera roll on mobile via platform pickers |
| PM-03 | Media bin with thumbnails, filter, search, tags, relink missing files | P0 | M1 | = | Virtualized; 10k items |
| PM-04 | Format support: H.264, HEVC, VP9, AV1, ProRes (native), MP4/MOV/WebM/MKV, JPEG/PNG/WebP/HEIC/AVIF/SVG/GIF, MP3/AAC/WAV/FLAC/Opus/OGG | P0 | M1-M2 | = | Per-platform matrix in ADR 0004; unsupported => clear message + transcode offer |
| PM-05 | Proxy and thumbnail cache (background, resumable) | P0 | M2 | + | Editing 4K on a phone depends on it |
| PM-06 | Autosave on every operation, crash recovery, version snapshots | P0 | M1 | + | Op-log journal (ADR 0006) |
| PM-07 | Open file format `.overcut` (zip + JSON), documented, versioned with migrations | P0 | M1 | + | Spec in `docs/` |
| PM-08 | Project library: duplicate, rename, archive, import/export project file | P0 | M2 | = | |
| PM-09 | Collect and consolidate (move media into project) / link in place | P1 | M2 | + | File System Access API where available |
| PM-10 | Record: screen, webcam, microphone / voice-over, system audio where the OS allows | P1 | M3 | = | `getDisplayMedia`, `MediaRecorder`, native capture on desktop/mobile |
| PM-11 | Built-in free media library (CC0/open-license video, images, music, SFX) with attribution kept | P1 | M7 | = | Index of open sources fetched on demand; never required |
| PM-12 | Offline everywhere; installable PWA | P0 | M1 | + | Service worker app shell; models downloaded on demand are cached |
| PM-13 | Bring-your-own-storage sync (folder, WebDAV, S3-compatible, Drive/Dropbox via user auth) | P2 | M8 | + | Optional; local-first remains the source of truth |
| PM-14 | Interchange import/export: EDL, FCPXML, OpenTimelineIO, SRT/VTT/ASS | P2 | M7 | + | Subtitles earlier (TX-10) |

## 2. Timeline and editing (TL)
| ID | Feature | Pri | M | CC | Notes |
|---|---|---|---|---|---|
| TL-01 | Multi-track timeline: video, overlay, audio, text/caption, effect tracks; unlimited tracks | P0 | M2 | = | M1 ships one video + one audio track |
| TL-02 | Split, trim (drag, numeric), delete, ripple delete, duplicate, copy/paste | P0 | M1 | = | |
| TL-03 | Snapping (playhead, clip edges, markers, beats), magnetic mode toggle | P0 | M2 | = | |
| TL-04 | Ripple, roll, slip, slide edits | P1 | M2 | + | Pro tools without a mode switch |
| TL-05 | Multi-select, marquee select, group/ungroup, link audio+video | P0 | M2 | = | |
| TL-06 | Unlimited undo/redo, history panel | P0 | M1 | = | Operation-based (ADR 0006) |
| TL-07 | Markers and chapters, in/out range, loop range | P1 | M2 | = | Chapters exported to MP4/YouTube description |
| TL-08 | Track controls: mute, solo, lock, hide, height, color, reorder | P0 | M2 | = | |
| TL-09 | Zoom and scroll for 10 s to 10 h timelines at 60 fps; pinch zoom on touch | P0 | M2 | = | Canvas-rendered, virtualized |
| TL-10 | Speed: constant, reverse, freeze frame, loop; audio pitch-preserve | P0 | M2 | = | |
| TL-11 | Speed ramps with bezier curves and presets | P1 | M4 | = | |
| TL-12 | Keyframes for every numeric property with easing and bezier editor | P0 | M2 | = | Graph editor for pros |
| TL-13 | Transform: position, scale, rotation, anchor, crop, flip, opacity, fit/fill | P0 | M2 | = | On-canvas handles, numeric fields |
| TL-14 | Picture-in-picture, overlays, stacking order | P0 | M2 | = | |
| TL-15 | Blend modes | P1 | M4 | = | |
| TL-16 | Masks: shape, freehand, feather, invert, keyframed, track-with-object | P1 | M4 | = | |
| TL-17 | Compound/nested clips; adjustment layers | P1 | M4 | + | Nested sequences |
| TL-18 | Transitions: cut, fade, dissolve, slides, wipes, zoom, glitch, shape; duration and easing | P0 | M4 | = | Pack of 40+ at 1.0, WGSL-based (EF-20) |
| TL-19 | Background fill (blur, color, gradient, image) for mismatched aspect | P0 | M2 | = | |
| TL-20 | Freeze, replace clip, extend, voice-over insertion, gap handling | P1 | M2 | = | |
| TL-21 | Multi-cam sync and switch (audio waveform sync) | P2 | post | + | Seam reserved |
| TL-22 | Time remap and variable frame rate handling (VFR to CFR on import) | P0 | M2 | = | Correct sync is a P0 bug class |
| TL-23 | Timeline search and filters (by type, name, effect) | P2 | M7 | + | |
| TL-24 | Resize project to another aspect ratio with automatic reframe | P1 | M6 | = | Uses AI-04 |

## 3. Preview and playback (PV)
| ID | Feature | Pri | M | CC | Notes |
|---|---|---|---|---|---|
| PV-01 | GPU-composited real-time preview, frame-accurate scrub, JKL, frame step | P0 | M1 | = | Budgets: `PERFORMANCE.md` |
| PV-02 | Proxy/low-res preview mode and adaptive quality under load | P0 | M2 | + | Never drop audio; drop video frames first |
| PV-03 | Full-screen and external-display preview; safe areas and guides | P1 | M3 | = | |
| PV-04 | Scopes: waveform, vectorscope, histogram | P2 | M4 | + | |
| PV-05 | Audio and video meters; loudness readout | P1 | M3 | = | |
| PV-06 | Playback of the whole timeline in the background while editing other things | P1 | M2 | = | Engine in a Worker |
| PV-07 | HDR and wide-gamut preview where the display supports it | P3 | post | + | Color management is designed for it from the start (ADR 0003) |

## 4. Text, captions and graphics (TX)
| ID | Feature | Pri | M | CC | Notes |
|---|---|---|---|---|---|
| TX-01 | Text layers: fonts, size, color, stroke, shadow, background, alignment, spacing | P0 | M3 | = | Open-license fonts bundled (OFL); system fonts where allowed |
| TX-02 | Text animations in/out/loop, per-character and per-word | P0 | M3 | = | Keyframe-based, WGSL-assisted |
| TX-03 | Text templates and styles library; save own styles | P1 | M3 | = | |
| TX-04 | Subtitle track: import/edit/export SRT, VTT, ASS; burn-in or sidecar | P0 | M3 | = | |
| TX-05 | Auto captions (on-device speech to text, 50+ languages) | P0 | M3 | = | AI-01 |
| TX-06 | Caption styling presets, karaoke word-highlight, emoji, auto line-breaking by language | P0 | M3 | = | |
| TX-07 | Shapes, lines, arrows, simple vector graphics, SVG import | P1 | M3 | = | |
| TX-08 | Stickers, emoji, animated stickers (Lottie/APNG/WebP) | P1 | M7 | = | Open-license packs |
| TX-09 | Lower-thirds, titles, end screens as templates | P1 | M7 | = | |
| TX-10 | Right-to-left and complex scripts (Arabic, Hebrew, Indic, CJK) shaped correctly | P0 | M3 | + | Shaping in engine (rustybuzz); a launch-blocker for global reach |
| TX-11 | Text to speech (on-device voices) | P1 | M6 | = | AI-08 |
| TX-12 | Auto-translate captions (on-device) | P1 | M6 | = | AI-02 |

## 5. Audio (AU)
| ID | Feature | Pri | M | CC | Notes |
|---|---|---|---|---|---|
| AU-01 | Waveforms on clips; volume, fade in/out, keyframed gain, pan | P0 | M1-M3 | = | Waveform M1, rest M3 |
| AU-02 | Multi-track mixer, solo/mute, master limiter | P0 | M3 | = | |
| AU-03 | Extract audio from video; detach/attach | P0 | M2 | = | |
| AU-04 | Auto ducking of music under speech | P1 | M3 | = | |
| AU-05 | Noise reduction, de-reverb, de-ess, wind noise | P0 | M3 | = | Classic DSP first; on-device ML later (AI-05) |
| AU-06 | EQ, compressor, limiter, gate presets | P1 | M3 | + | |
| AU-07 | Loudness normalization (LUFS targets per platform) | P1 | M3 | + | |
| AU-08 | Beat detection and beat markers; cut to beat | P1 | M3 | = | |
| AU-09 | Voice effects (pitch, robot, chorus, etc.) | P1 | M3 | = | |
| AU-10 | Sound effects and music from the free library | P1 | M7 | = | PM-11 |
| AU-11 | Stem separation (vocals/music) on-device | P2 | M6 | + | AI-06 |
| AU-12 | Audio-only projects; export WAV/MP3/AAC/FLAC/Opus | P1 | M3 | + | |

## 6. Effects, color and compositing (EF)
| ID | Feature | Pri | M | CC | Notes |
|---|---|---|---|---|---|
| EF-01 | Filters and looks (50+ at 1.0) with strength; save own | P0 | M4 | = | |
| EF-02 | LUT import (.cube/.3dl) and apply, per clip or adjustment layer | P1 | M4 | + | |
| EF-03 | Color tools: exposure, contrast, saturation, temperature, tint, highlights/shadows, HSL, curves, color wheels | P0 | M4 | = | Linear-light pipeline |
| EF-04 | Blur (gaussian, radial, directional), sharpen, vignette, grain, glow, mosaic | P0 | M4 | = | |
| EF-05 | Chroma key (green screen) with spill suppression | P0 | M4 | = | |
| EF-06 | Video stabilization | P1 | M4 | = | Feature tracking in the engine |
| EF-07 | Motion tracking: attach text/graphics to a moving point | P1 | M4 | = | |
| EF-08 | Effects: glitch, shake, RGB split, VHS, mirror, zoom pulse, light leaks, etc. (60+ at 1.0) | P1 | M4 | = | Declarative effect definitions (EF-20) |
| EF-09 | Auto color match between clips | P2 | M6 | + | |
| EF-10 | Slow motion by frame interpolation (optical flow / RIFE) | P1 | M6 | = | AI-09 |
| EF-11 | Video denoise, upscale (2x/4x) | P2 | M6 | = | AI-10 |
| EF-20 | Effects and transitions as data + WGSL: a public, sandboxed format that the built-in pack itself uses | P0 | M4 | + | Foundation of the plugin ecosystem (EX-01) |
| EF-21 | Keyframe-able effect parameters, effect stacking and reordering, presets | P0 | M4 | = | |

## 7. On-device AI (AI)
All models are open-weight, downloaded on request, cached, removable, run locally (WebGPU/WASM SIMD on web, native runtimes on apps). No cloud, no account. Quality tiers adapt to device.

| ID | Feature | Pri | M | CC | Notes |
|---|---|---|---|---|---|
| AI-01 | Speech to text: auto captions with word timing, language detect, speaker labels | P0 | M3 | = | Whisper-class model |
| AI-02 | Caption translation (many languages) | P1 | M6 | = | |
| AI-03 | Background removal for video (no green screen) | P0 | M6 | = | Matting model, temporal smoothing |
| AI-04 | Smart reframe: keep subjects in frame when changing aspect ratio | P0 | M6 | = | Detection + tracking |
| AI-05 | Speech enhancement / noise suppression (neural) | P1 | M6 | = | |
| AI-06 | Stem / vocal separation | P2 | M6 | + | |
| AI-07 | Silence, filler-word and retake removal; edit video by editing the transcript | P0 | M6 | = | Text-based editing is a flagship |
| AI-08 | Text to speech with multiple voices/languages | P1 | M6 | = | Open voices |
| AI-09 | Frame interpolation for smooth slow motion | P1 | M6 | = | |
| AI-10 | Upscaling and video denoise | P2 | M6 | = | |
| AI-11 | Scene detection and auto-split; highlight detection | P1 | M6 | = | |
| AI-12 | Auto beat-synced edit; auto-cut a draft from raw clips | P2 | M6 | = | |
| AI-13 | Object removal / inpainting | P3 | post | = | Heavy; evaluate |
| AI-14 | Optional bring-your-own-key cloud integrations (e.g. generative) clearly marked as off-device | P3 | post | + | Never required, never default |

## 8. Export and share (EX)
| ID | Feature | Pri | M | CC | Notes |
|---|---|---|---|---|---|
| EX-01 | Export MP4 (H.264/HEVC/AV1) and WebM (VP9/AV1) up to 4K 60 fps; 8K and 120 fps on capable hardware | P0 | M1 | = | M1: 1080p30 H.264 |
| EX-02 | Presets per platform (YouTube, TikTok, Reels, Shorts, X, Facebook, WhatsApp, Discord size limits) and custom | P0 | M1 | = | Size-targeted bitrate for upload caps |
| EX-03 | Export queue, background export, pause/resume, estimate, progress notifications | P0 | M2 | = | Survives tab/app restarts where the OS allows |
| EX-04 | Hardware encoding where available; software fallback | P0 | M1 | = | |
| EX-05 | GIF / animated WebP / APNG; still frame; image sequence | P1 | M2 | = | |
| EX-06 | Transparent video (WebM alpha, ProRes 4444) | P1 | M4 | + | |
| EX-07 | Subtitle sidecar export; chapters | P1 | M3 | + | |
| EX-08 | Share sheet / save to gallery / copy to clipboard; direct upload with user's own account (optional) | P1 | M3 | = | No Overcut server involved |
| EX-09 | Headless CLI: `overcut render project.overcut out.mp4` (same engine) | P1 | M7 | + | Automation, servers, CI |
| EX-10 | Export of project as template (media replaced by slots) | P1 | M7 | = | |

## 9. Experience and platform (UX)
| ID | Feature | Pri | M | CC | Notes |
|---|---|---|---|---|---|
| UX-01 | Responsive layouts: phone (portrait/landscape), tablet, laptop, desktop, ultrawide; foldables | P0 | M1 | = | Designed per form factor, one component set |
| UX-02 | Touch gestures (pinch, drag, long-press, two-finger pan), stylus, mouse, trackpad | P0 | M2 | = | |
| UX-03 | Keyboard-first: full shortcut set, customizable, presets (CapCut, Premiere, Final Cut, DaVinci) | P0 | M2 | + | |
| UX-04 | Command palette (search every action and setting) | P1 | M2 | + | |
| UX-05 | Themes: dark, light, high contrast; accent colors; follows system | P0 | M1 | = | |
| UX-06 | Accessibility: screen reader labels, focus order, full keyboard operation, reduced motion, WCAG 2.2 AA | P0 | M9 | + | Built in from M1, audited at M9 |
| UX-07 | Localization: 25+ languages at 1.0, community translation workflow, RTL | P0 | M9 | = | i18n plumbing at M1 |
| UX-08 | Onboarding: 60-second guided first edit; contextual tips; sample project | P0 | M3 | = | |
| UX-09 | Templates gallery (starter timelines, caption styles, intros/outros) | P1 | M7 | = | |
| UX-10 | Multi-window and external panels on desktop (preview on second screen) | P2 | post | + | |
| UX-11 | Hardware controllers: jog/shuttle, MIDI, gamepad | P3 | post | + | |
| UX-12 | Drag media to and from other apps; file associations (`.overcut`); handoff between devices via file | P1 | M5 | = | |
| UX-13 | In-app help, docs search, keyboard cheat-sheet overlay | P1 | M3 | = | |

## 10. Extensibility, collaboration, trust (XT)
| ID | Feature | Pri | M | CC | Notes |
|---|---|---|---|---|---|
| XT-01 | Plugin API: effects, transitions, generators, caption styles, template packs (sandboxed, declarative + WGSL; no arbitrary native code on mobile/web) | P1 | M7 | + | |
| XT-02 | Scripting/automation API on the same operations as the UI | P2 | M7 | + | Operations are the API (ADR 0006) |
| XT-03 | Share a project for live co-editing, peer-to-peer (CRDT over WebRTC), no server holding media | P2 | M8 | + | |
| XT-04 | Review comments and markers on a shared link/file | P2 | M8 | = | |
| XT-05 | Version history with named snapshots and diff of timeline changes | P2 | M8 | + | Falls out of the operation log |
| XT-06 | Privacy: no telemetry by default; opt-in crash reports; visible network log; no third-party scripts | P0 | M1 | + | Enforced by CSP and a test |
| XT-07 | Update mechanism (web: service worker; desktop: signed updater; mobile: stores) | P0 | M5 | = | |
| XT-08 | Security: sandboxed plugin runtime, strict CSP, memory-safe engine, fuzzed demuxers | P0 | M1-M9 | + | |

## Coverage check
CapCut-equivalent areas covered: project/media, multi-track timeline, keyframes, speed ramps, transitions, effects, filters, color, masks, chroma key, text, captions (auto + translate), stickers, TTS, voice effects, noise reduction, beat sync, background removal, smart reframe, stabilization, tracking, templates, export presets, mobile + desktop + web. Beyond CapCut: open format, on-device privacy, CLI, plugins, transcript editing, optional P2P collaboration, no gates.
