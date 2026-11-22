# S1 spike: WebCodecs decode to WebGPU (M1-010)

Throwaway spike, not part of the app bundle and not linked from the UI. Question and success bar: `docs/IMPLEMENTATION_PLAN.md` §1 (S1). Results: `docs/adr/0004-media-io.md` ("S1 results").

- `gen-clip.mjs`: regenerates the two 1080p30 H.264 (High, 2 B-frames) clips, 150 frames each, GOP 30 and GOP 150. The frame number is burned into the pixels as 16 white/black 64 px blocks, so identity survives lossy coding and YUV to RGB. Needs `ffmpeg` and `ffprobe` (dev only). Clips and their packet index (`*.json`: offset, size, pts, dts, key) are committed (836 KiB total).
- `spike.js` + `index.html`: the page. Demux (index + `avcC` box), `VideoDecoder` seek from the previous keyframe through the target (B-frame aware), then three ways onto the GPU: `importExternalTexture`, `copyExternalImageToTexture`, and `VideoFrame.copyTo` + `writeTexture` (the CPU fallback). Each frame is rendered to a 1080p texture, the burned-in code is read back and compared with the requested frame number.
- `run.mjs`: serves the folder, runs each path in a fresh headless Chromium, prints and writes JSON.

```
CHROMIUM_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome \
  node spikes/s1-webcodecs/run.mjs --clip clip-gop30 --out results.json
```

`--gpu default` drops the SwiftShader flags (use on real hardware); `--flags "a;b"` adds browser flags. Open `index.html?clip=clip-gop30&mode=importExternalTexture` over http(s) in any browser to run one path by hand; the result is shown on the page and in `window.__result`.
