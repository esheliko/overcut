#!/bin/sh
# Regenerates the tiny demux fixtures (needs ffmpeg with libx264, libvpx-vp9, libopus, aac). Output is checked in; total < 150 KB.
# Run from this directory: ./make.sh. Expectations in ../demux.rs were cross-checked against `ffprobe -show_packets`.
set -e
V="-f lavfi -i testsrc=size=160x120:rate=30:duration=1"
A="-f lavfi -i sine=frequency=440:sample_rate=48000:duration=1"
Q="-y -hide_banner -loglevel error -bitexact"
# H.264 High (B-frames, so ctts) + AAC-LC in MP4, 30 fps CFR
ffmpeg $Q $V $A -c:v libx264 -profile:v high -level 3.0 -g 15 -bf 2 -pix_fmt yuv420p -c:a aac -b:a 32k -movflags +faststart h264_aac.mp4
# Same streams in QuickTime MOV
ffmpeg $Q -i h264_aac.mp4 -c copy -f mov h264_aac.mov
# Display rotation 90 degrees (tkhd matrix)
ffmpeg $Q -display_rotation 90 -i h264_aac.mp4 -c copy rotated90.mp4
# Variable frame rate: irregular timestamps, video only
ffmpeg $Q $V -vf "setpts='PTS*(1+(mod(N,3)))'" -c:v libx264 -g 10 -bf 0 -pix_fmt yuv420p -fps_mode vfr vfr.mp4
# VP9 + Opus in WebM
ffmpeg $Q $V $A -c:v libvpx-vp9 -b:v 100k -g 15 -c:a libopus -b:a 24k vp9_opus.webm
# Fragmented MP4 (what phones, screen recorders and MediaRecorder write): empty moov + mvex, one moof per ~0.5 s
ffmpeg $Q -i h264_aac.mp4 -c copy -movflags frag_keyframe+empty_moov+default_base_moof -frag_duration 500000 frag.mp4
# Same, but the old style: base offsets relative to moof start are implicit, per-sample sizes/durations come from trex/tfhd defaults
ffmpeg $Q -i h264_aac.mp4 -c copy -movflags frag_keyframe+empty_moov -frag_duration 500000 frag_legacy.mp4
