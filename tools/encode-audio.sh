#!/usr/bin/env bash
# Encode the TTS voice lines (WAV) to small mono MP3s for the web, and slim the music.
# Run in WSL/Linux with ffmpeg: bash tools/encode-audio.sh
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p public/audio/lines
for f in art-src/voice-wav/*.wav; do
  ffmpeg -loglevel error -y -i "$f" -af "loudnorm=I=-16:TP=-1.5" -ac 1 -ar 24000 -b:a 48k "public/audio/lines/$(basename "${f%.wav}").mp3"
done
# Lyria originals live in art-src/music-src (git-ignored); the game ships slimmer copies
mkdir -p public/audio/music
for f in art-src/music-src/*.mp3; do
  ffmpeg -loglevel error -y -i "$f" -af "loudnorm=I=-20:TP=-2" -ac 2 -b:a 96k "public/audio/music/$(basename "$f")"
done
du -sh public/audio/lines public/audio/music
for f in public/audio/music/*.mp3; do echo "$f $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")s"; done
