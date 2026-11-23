#!/bin/sh
# Regenerates tests/fixtures/longgop.mp4 (needs ffmpeg with libx264). Output is checked in.
# Long-GOP phone-style footage for the scrub strip (docs/features/preview.md "Smooth scrubbing"): 1280x720, 10 s at 30 fps, one keyframe every 150 frames,
# 2 B-frames, light grain so the picture is not trivially compressible. Run from this directory: ./make.sh
set -e
ffmpeg -y -hide_banner -loglevel error -bitexact -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=10,noise=alls=10:allf=t" \
  -c:v libx264 -preset veryfast -crf 30 -g 150 -keyint_min 150 -sc_threshold 0 -bf 2 -pix_fmt yuv420p -movflags +faststart longgop.mp4
