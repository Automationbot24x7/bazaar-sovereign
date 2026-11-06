#!/usr/bin/env bash
# Builds the 90-second demo video from gameplay shots, the narration and the game's own music.
# Run in WSL/Linux with ffmpeg:  bash tools/video/build.sh
# In:  art-src/video/shots/*.jpg, art-src/video/vo/s1..s8.wav, public/audio/music/*.mp3, public/art/bazaar.webp
# Out: art-src/video/bazaar-sovereign-demo.mp4 (1920x1080, 30 fps, H.264 + AAC)
set -euo pipefail
cd "$(dirname "$0")/../.."
V=art-src/video; S=$V/shots; T=$V/tmp; mkdir -p "$T"
SANS=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
SERIF=/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf
GAP=0.45   # breath after each narration line
dur() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1"; }

# segment: narration id | caption | shots (seconds split evenly between them)
SEGMENTS=(
  "s1|Every merchant is an NFT with its own wallet|ART:bazaar 01-opening-scene.jpg"
  "s2|A charter NFT that does something|02-stalls-day0.jpg CROP:02b-nearblocks-charter.jpg"
  "s3|Rivals with memory and grudges|03-rumor-decision.jpg"
  "s4|Atomic deals through escrow|05-haggle-counter.jpg"
  "s5|Day 6: the Magnate arrives|06-baltazar-speech.jpg 07-magnate-arrives.jpg"
  "s6|Fight him together, or lose the bazaar|08-pact-replies.jpg 09b-teodora-loyal.jpg"
  "s7|Every move is on-chain|09-kasim-goodbye.jpg 10-onchain-feed.jpg"
  "s8|Play free: bazaar.reconscribe.com|END"
)

# one still -> a slow-zoom clip with the caption in a bottom band
clip() { # out seconds source caption
  local out=$1 secs=$2 src=$3 cap=$4 frames pre
  frames=$(awk "BEGIN{printf \"%d\", $secs*30}")
  case "$src" in
    END)    ;;
    ART:*)  pre="scale=3840:2160:force_original_aspect_ratio=increase,crop=3840:2160"; src=public/art/${src#ART:}.webp ;;
    CROP:*) pre="crop=910:470:538:190,scale=-2:1800,pad=3840:2160:(ow-iw)/2:60:color=0x120b07"; src=$S/${src#CROP:} ;;
    *)      pre="scale=3840:-2,pad=3840:2160:0:40:color=0x120b07"; src=$S/$src ;;   # shots are wider than 16:9: image on top, caption band below
  esac
  local band="drawbox=y=ih-150:w=iw:h=150:color=0x120b07@0.92:t=fill"
  local text="drawtext=fontfile=$SANS:text='${cap//:/\\:}':fontsize=46:fontcolor=0xf0bd45:x=(w-tw)/2:y=h-98"
  if [ "$src" = END ]; then
    ffmpeg -loglevel error -y -loop 1 -t "$secs" -i public/art/bazaar.webp -vf "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,eq=brightness=-0.32:saturation=0.8,\
drawtext=fontfile=$SERIF:text='Bazaar Sovereign':fontsize=110:fontcolor=0xf0bd45:x=(w-tw)/2:y=330,\
drawtext=fontfile=$SANS:text='Every merchant is an NFT that owns its own NEAR wallet':fontsize=40:fontcolor=0xf3e6cc:x=(w-tw)/2:y=480,\
drawtext=fontfile=$SANS:text='Play free\: bazaar.reconscribe.com':fontsize=56:fontcolor=white:x=(w-tw)/2:y=600,\
drawtext=fontfile=$SANS:text='Built on NEAR testnet · NEAR Hackathon 2026':fontsize=32:fontcolor=0xcbb894:x=(w-tw)/2:y=700,\
fade=t=in:d=0.4,format=yuv420p" -r 30 -c:v libx264 -preset medium -crf 20 "$out"
    return
  fi
  ffmpeg -loglevel error -y -framerate 30 -loop 1 -t "$secs" -i "$src" -vf "$pre,\
zoompan=z='min(zoom+0.00045,1.08)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=30,\
$band,$text,fade=t=in:d=0.25,fade=t=out:st=$(awk "BEGIN{print $secs-0.25}"):d=0.25,format=yuv420p" \
    -frames:v "$frames" -r 30 -c:v libx264 -preset medium -crf 20 "$out"
}

: > "$T/list.txt"; : > "$T/vo-list.txt"; t=0; n=0; music_switch=0; finale_at=0
for seg in "${SEGMENTS[@]}"; do
  IFS='|' read -r id cap shots <<< "$seg"
  vo=$V/vo/$id.wav; d=$(dur "$vo"); total=$(awk "BEGIN{print $d+$GAP}")
  [ "$id" = s8 ] && total=$(awk "BEGIN{print $d+2.5}")   # hold the end card
  read -ra list <<< "$shots"; each=$(awk "BEGIN{print $total/${#list[@]}}")
  for src in "${list[@]}"; do n=$((n+1)); clip "$T/c$n.mp4" "$each" "$src" "$cap"; echo "file 'c$n.mp4'" >> "$T/list.txt"; done
  echo "file '$(realpath "$vo")'" >> "$T/vo-list.txt"
  ffmpeg -loglevel error -y -f lavfi -t "$(awk "BEGIN{print $total-$d}")" -i anullsrc=r=24000:cl=mono "$T/gap-$id.wav"
  echo "file '$(realpath "$T/gap-$id.wav")'" >> "$T/vo-list.txt"
  [ "$id" = s5 ] && music_switch=$t
  [ "$id" = s8 ] && finale_at=$t
  t=$(awk "BEGIN{print $t+$total}")
  echo "$id ${#list[@]} shot(s) ${total}s (ends at ${t}s)"
done

ffmpeg -loglevel error -y -f concat -safe 0 -i "$T/list.txt" -c copy "$T/video.mp4"
ffmpeg -loglevel error -y -f concat -safe 0 -i "$T/vo-list.txt" -ar 48000 -ac 2 "$T/vo.wav"
# music bed: bazaar theme, the magnate's theme from his arrival, the finale over the end card; ducked under the voice
ffmpeg -loglevel error -y -i public/audio/music/bazaar.mp3 -i public/audio/music/magnate.mp3 -i public/audio/music/finale.mp3 -filter_complex "\
[0]atrim=0:$music_switch,afade=t=out:st=$(awk "BEGIN{print $music_switch-1}"):d=1[a];\
[1]atrim=0:$(awk "BEGIN{print $finale_at-$music_switch}"),afade=t=in:d=1,afade=t=out:st=$(awk "BEGIN{print $finale_at-$music_switch-1}"):d=1[b];\
[2]atrim=0:$(awk "BEGIN{print $t-$finale_at}"),afade=t=in:d=0.8,afade=t=out:st=$(awk "BEGIN{print $t-$finale_at-1.2}"):d=1.2[c];\
[a][b][c]concat=n=3:v=0:a=1,volume=0.22,aresample=48000[m]" -map "[m]" -ac 2 "$T/music.wav"
ffmpeg -loglevel error -y -i "$T/video.mp4" -i "$T/vo.wav" -i "$T/music.wav" -filter_complex "\
[1]volume=1.0[v];[2][v]sidechaincompress=threshold=0.04:ratio=6:attack=20:release=400[mduck];[mduck][1]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a pcm_s16le -shortest "$T/mixed.mkv"
# loudness for YouTube/X: about -15 LUFS, peaks under -1.5 dBTP
ffmpeg -loglevel error -y -i "$T/mixed.mkv" -c:v copy -af loudnorm=I=-15:TP=-1.5:LRA=7 -ar 48000 -c:a aac -b:a 160k -movflags +faststart "$V/bazaar-sovereign-demo.mp4"
echo "done: $V/bazaar-sovereign-demo.mp4 ($(dur "$V/bazaar-sovereign-demo.mp4")s, $(du -h "$V/bazaar-sovereign-demo.mp4" | cut -f1))"
