# 0007 React UI, canvas timeline, effects as data
**Status**: proposed

**Decision.** UI: React 19 + Vite + plain CSS with design tokens and container-query layouts; no large component library (bundle and control). The timeline, waveforms and scopes are canvas/GPU rendered and virtualized, not DOM. Accessibility via headless primitives and an alternative list/keyboard model of the timeline. Effects, transitions, generators and caption styles are **data + WGSL** (manifest + shader) and the built-in pack uses the same format as third-party plugins (EF-20, XT-01); plugins cannot run native code on web/mobile.

**Consequences.** (+) fast UI, small bundle, a real plugin ecosystem from day one, safe sandbox. (-) a custom timeline widget is real work (S8); the effect format must be designed carefully (versioned, with a conformance test suite) because it becomes public API.
