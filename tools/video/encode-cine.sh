#!/usr/bin/env bash
# Web copies of the SandBase clips (art-src/cine/clips, from tools/video/gen-cine.mjs):
#   scene-*    -> public/video/scene-*.mp4      1280x720, looping backdrops for the story scenes
#   portrait-* -> public/video/portrait-*.mp4   360x360, looping speaking portraits
# Model audio is dropped; the game has its own voices and music. Trailer clips stay in art-src for the demo video.
# Run in WSL/Linux with ffmpeg: bash tools/video/encode-cine.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p public/video
for f in art-src/cine/clips/scene-*.mp4; do
  ffmpeg -loglevel error -y -i "$f" -an -vf "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,fps=24,format=yuv420p" \
    -c:v libx264 -profile:v high -crf 26 -preset slow -movflags +faststart "public/video/$(basename "$f")"
done
for f in art-src/cine/clips/portrait-*.mp4; do
  ffmpeg -loglevel error -y -i "$f" -an -vf "crop='min(iw,ih)':'min(iw,ih)',scale=360:360,fps=24,format=yuv420p" \
    -c:v libx264 -profile:v high -crf 25 -preset slow -movflags +faststart "public/video/$(basename "$f")"
done
du -ch public/video/*.mp4 | tail -1
