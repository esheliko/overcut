# S10 proxy spike (M2-020, ADR 0016)
Throw-away. `ffmpeg` CLI with libx264 stands in for the encoder (the product uses WebCodecs / platform encoders; libx264 is GPL and is never shipped).
- Source: `ffmpeg -f lavfi -i "testsrc2=size=3840x2160:rate=30,noise=alls=12:allf=t,format=yuv420p" -t 24 -c:v libx264 -preset veryfast -b:v 45M -maxrate 60M -bufsize 60M -g 150 -bf 2 src4k.mp4` (45 Mbps, GOP 150, 2 B-frames, phone-like).
- `node bench.mjs src4k.mp4 <dir> [seeks]`: size, transcode speed (4 cores and 1 core) and 30 seeded random accurate seeks (1 decode thread, minus open cost) per proxy shape. Result: `bench.json`.
- `node resume.mjs src4k.mp4 <dir> 4 9000`: 4 s closed-GOP segments, `kill -9` of the build after 9 s, drop the partial `.tmp`, resume, compare with an uninterrupted build. Result: `resume.json`.
Container numbers (4 shared vCPU, software decode and encode, no GPU) are trends, not device numbers.
