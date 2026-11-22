# S3 spike: WebCodecs encode + mux with A/V sync (M1-014)

Throwaway spike, not in the app bundle (not an npm workspace, not linked from the UI). Question and success bar: `docs/IMPLEMENTATION_PLAN.md` §1 (S3). Results: `docs/adr/0004-media-io.md` ("S3 results").

- `worker.js`: runs in a Worker. Synthetic 1080p30 scene (OffscreenCanvas; one all-white flash frame every second) plus a 48 kHz stereo click track (3 ms 2 kHz burst starting at exactly the flash frame's timestamp). `VideoEncoder` (H.264 `avc1.640028`, VP9, AV1) and `AudioEncoder` (AAC `mp4a.40.2` when supported, else Opus) feed `mp4-muxer` / `webm-muxer` (MIT). Backpressure on `encodeQueueSize`, progress message about once a second, `cancel` closes both encoders without flushing.
- `index.html`: tiny page that spawns the worker; driven by `run.mjs`.
- `run.mjs`: serves the folder, runs one encode in headless Chromium, writes `out/<codec>-<container>-<s>s.<ext>` and `out/result-*.json`, then calls `verify.mjs`.
- `verify.mjs`: needs `ffmpeg`/`ffprobe` (dev only). Decodes the output the way a player would (edit lists applied), finds flash frames (video pts) and click onsets (audio samples), prints the per-second offset, its max, and its drift per minute. Works on any file: `node verify.mjs file.mp4 300`.

```
cd spikes/s3-encode && npm install            # mp4-muxer, webm-muxer (kept out of the root lockfile on purpose)
CHROMIUM_PATH=/path/to/chrome node run.mjs --codec h264 --container mp4 --seconds 300
node run.mjs --codec vp9 --container webm --seconds 300
node run.mjs --codec h264 --container mp4 --seconds 60 --cancel-after 2 --verify 0   # cancel test
```
Flags: `--acodec aac|opus|auto`, `--vbitrate 8000000`, `--hw prefer-hardware` (use on real devices), `--flags "a;b"` for browser flags. To test another browser, open `index.html` over http(s) and call `window.__start({codec, container, seconds, width:1920, height:1080, fps:30, vbitrate:8e6, abitrate:128e3})`; the worker POSTs the file to `/out/` (replace that with a download link for manual use).
