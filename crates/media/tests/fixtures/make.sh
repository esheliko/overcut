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
# A/V sync fixture for the preview (tests/smoke/preview.spec.ts): 3 s, black picture with ONE white frame at 1.000 s, and a 1 kHz click starting at the same instant
ffmpeg $Q -f lavfi -i "color=c=black:size=320x180:rate=30:duration=3,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(t,1,1.03)'" \
  -f lavfi -i "aevalsrc='if(between(t,1,1.02),0.8*sin(2*PI*1000*t),0)':s=48000:d=3" \
  -c:v libx264 -g 30 -bf 0 -pix_fmt yuv420p -c:a aac -b:a 64k -movflags +faststart flash_click.mp4
# Audio-only WebM (Opus), the shape of a voice recording saved as .webm (browsers report it as video/webm): 1 s, 440 Hz. Used by tests/smoke/media-bin.spec.ts.
ffmpeg $Q -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=1" -c:a libopus -b:a 24k audio_only.webm
# Stills for tests/smoke/stills.spec.ts: a red landscape PNG and a blue portrait JPG.
ffmpeg $Q -f lavfi -i "color=c=red:s=320x180" -frames:v 1 still_red.png
ffmpeg $Q -f lavfi -i "color=c=0x2060ff:s=200x300" -frames:v 1 -q:v 5 still_blue_portrait.jpg
# Full-range colour declared by the container (the shape of our own exports and most screen recordings): WebM `Colour` (range 2, bt709) and MP4 `colr`/nclx. Video only.
ffmpeg $Q $V -c:v libvpx-vp9 -b:v 60k -g 15 -pix_fmt yuv420p -color_range pc -colorspace bt709 -color_primaries bt709 -color_trc iec61966-2-1 colour_full.webm
ffmpeg $Q $V -c:v libx264 -g 15 -bf 0 -pix_fmt yuv420p -color_range pc -colorspace bt709 -color_primaries bt709 -color_trc bt709 colour_full.mp4
# Phone-like: the audio track is shorter than the picture (1.5 s video, 1 s audio). Reading audio to the end of the picture used to fail with "out of range" in export.
ffmpeg $Q -f lavfi -i testsrc=size=160x120:rate=30:duration=1.5 -f lavfi -i sine=frequency=440:sample_rate=48000:duration=1 -c:v libvpx-vp9 -b:v 100k -g 15 -c:a libopus -b:a 24k vp9_opus_short_audio.webm
# Audio-only: an MP3 (libmp3lame, ID3v2 + Xing frame, mono 44.1 kHz) and a PCM WAV (mono 8 kHz, 16-bit).
ffmpeg $Q -f lavfi -i sine=frequency=440:duration=1:sample_rate=44100 -ac 1 -c:a libmp3lame -b:a 64k tone.mp3
ffmpeg $Q -f lavfi -i sine=frequency=440:duration=0.5:sample_rate=8000 -ac 1 -c:a pcm_s16le tone.wav
