#!/usr/bin/env python3
"""Demo video v2: crisp 2x stills (cropped + slow pans), real motion clips from the recorded
season, a Blender title intro, crossfades, captions, voice-over and the game's music.
Run in WSL/Linux with ffmpeg:  python3 tools/video/build2.py
In:  art-src/video/cap/{stills/*.png, frames/*.jpg, frames.json, marks.json}, art-src/video/intro/intro_*.png,
     art-src/video/vo/s1..s8.wav, art-src/video/shots/02b-nearblocks-charter.jpg, public/audio/music/*.mp3
Out: art-src/video/bazaar-sovereign-demo.mp4
"""
import json, os, subprocess, shutil

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.chdir(ROOT)
V, T = 'art-src/video', 'art-src/video/tmp2'
CAP = os.environ.get('CAP', 'art-src/video/cap')   # which recorded season to cut from
shutil.rmtree(T, ignore_errors=True); os.makedirs(T)
SANS = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
SERIF = '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf'
FPS, XF, GAP = 30, 0.4, 0.45

def run(*args):
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', *args], check=True)
def dur(f):
    return float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).decode())
def winpath(p):  # frames.json was written on Windows
    return '/mnt/' + p[0].lower() + p[2:] if len(p) > 1 and p[1] == ':' else p

marks = {m['name']: m['t'] for m in json.load(open(f'{CAP}/marks.json'))}
frames = [(winpath(f['f']), f['t']) for f in json.load(open(f'{CAP}/frames.json'))]

# shots, in CSS pixels of the 1920x1080 page (stills are 2x): pan from box A to box B, both 16:9
STILL = lambda name, w, a, b: ('still', f'{CAP}/stills/{name}.png', w, a, b)
CLIP = lambda t0, w, a: ('clip', t0, w, a)
CINE = lambda name: ('cine', f'art-src/cine/clips/{name}.mp4')   # animated paintings (tools/video/gen-cine.mjs)
# the living street: motion clips where the season gave us one, stills where it didn't
BOARD = (160, 60)
# day-stamped names change from season to season: take the first one with the prefix
mk = lambda pre: next((m for m in marks if m.startswith(pre)), pre)
# the opening board shot: the first moment the season is running (not the frozen day 0)
RUNNING = next((m for m in marks if m.startswith('event-')), 'board-idle')
st = lambda pre: next((f[:-4] for f in sorted(os.listdir(f'{CAP}/stills')) if f.startswith(pre)), pre)
EVENT = next((m for m in ('event-caravan', 'event-festival', 'event-storm', 'event-monsoon', 'event-drought') if m in marks), None)
s3_extra = [CLIP(EVENT, 1920, (0, 0))] if EVENT else []
wagon = [CLIP('magnate-wagon', 1920, (0, 0))] if 'magnate-wagon' in marks else []
SEGMENTS = [
    ('s1', 'Every merchant is an NFT with its own wallet', [('intro',), CINE('trailer-flyin'), CLIP(RUNNING, 1920, (0, 0))]),
    ('s2', 'A charter NFT that does something', [STILL(st('cry-verdict'), 1152, (0, 300), (768, 300)), STILL(st('inspector'), 1280, (320, 80), (320, 200))]),
    ('s3', 'Rivals that shout, scheme and hold grudges', [STILL(st('decision-rumor'), 1280, (300, 140), (360, 170)), CLIP('cry', 1920, (0, 0)), CLIP(mk('decision-palace'), 1920, (0, 0))]),
    ('s4', 'Atomic deals through escrow', [STILL('haggle-reply', 960, (470, 262), (490, 282)), STILL('haggle-deal', 960, (480, 266), (480, 280))]),
    ('s5', 'Day 6: the Magnate arrives', [CINE('trailer-arrival'), STILL(st('decision-magnate'), 1440, (0, 100), (240, 140)), *wagon]),
    ('s6', 'Fight him together, or lose the bazaar', [STILL('pact-replies', 1152, (0, 96), (40, 110)), CLIP(mk('raid-d'), 1920, (0, 0)), CINE('scene-wins')]),
    ('s7', 'Every move is on-chain', [CINE('scene-leaves'), STILL('onchain-feed', 1152, (768, 420), (768, 432))]),
    ('s8', 'Play free: bazaar.reconscribe.com', [CINE('trailer-festival'), STILL('end-screen', 960, (480, 245), (480, 262)), ('end',)]),
]
# a shot whose still or mark is missing from this capture is dropped rather than failing the build
SEGMENTS = [(sid, cap, [sh for sh in shots if (sh[0] not in ('still', 'cine') or os.path.exists(sh[1])) and (sh[0] != 'clip' or sh[1] in marks)]) for sid, cap, shots in SEGMENTS]

BAND = "drawbox=y=ih-130:w=iw:h=130:color=0x120b07@0.88:t=fill"
def caption(cap):
    return f"{BAND},drawtext=fontfile={SANS}:text='{cap.replace(':', chr(92) + ':')}':fontsize=44:fontcolor=0xf0bd45:x=(w-tw)/2:y=h-86"

def still_clip(out, secs, src, w, a, b, cap):
    h = w * 9 // 16; W, H = 2 * w, 2 * h; ax, ay, bx, by = [2 * v for v in (*a, *b)]
    n = round(secs * FPS)
    vf = (f"crop={W}:{H}:'{ax}+({bx}-{ax})*min(1,t/{secs})':'{ay}+({by}-{ay})*min(1,t/{secs})',"
          f"scale=1920:1080:flags=lanczos,{caption(cap)},format=yuv420p")
    run('-framerate', str(FPS), '-loop', '1', '-t', f'{secs}', '-i', src, '-vf', vf, '-frames:v', str(n), '-r', str(FPS), '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', out)

def motion_clip(out, secs, t0, w, a, cap):
    # frames between t0 and t0+secs, each held until the next one (variable rate -> 30 fps)
    sel = [(f, t) for f, t in frames if t0 - 0.2 <= t <= t0 + secs + 0.5]
    lst = f'{out}.txt'
    with open(lst, 'w') as fh:
        for i, (f, t) in enumerate(sel):
            nxt = sel[i + 1][1] if i + 1 < len(sel) else t + 1 / FPS
            fh.write(f"file '{f}'\nduration {max(0.001, nxt - t):.4f}\n")
        fh.write(f"file '{sel[-1][0]}'\n")
    h = w * 9 // 16
    # gameplay frames are native 1920x1080: a full-frame clip is used as is (no enlarging, so text stays sharp)
    vf = f"fps={FPS},crop={w}:{h}:{a[0]}:{a[1]},{'' if w == 1920 else 'scale=1920:1080:flags=lanczos,'}{caption(cap)},format=yuv420p"
    run('-f', 'concat', '-safe', '0', '-i', lst, '-vf', vf, '-t', f'{secs}', '-r', str(FPS), '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', out)

def cine_clip(out, secs, src, cap):
    # a 5 s painting clip stretched gently (slow motion) to fill its slot
    k = max(1.0, secs / dur(src))
    vf = f"setpts={k:.4f}*PTS,scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps={FPS},{caption(cap)},format=yuv420p"
    run('-i', src, '-an', '-vf', vf, '-t', f'{secs}', '-r', str(FPS), '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', out)

def intro_clip(out, secs):
    # the 4 s Blender title, played faster to fit its short slot
    vf = f"setpts={min(1.0, secs / 4.2):.4f}*PTS,fps={FPS},tpad=stop_mode=clone:stop_duration=10,format=yuv420p"
    run('-framerate', str(FPS), '-i', f'{V}/intro/intro_%04d.png', '-vf', vf, '-t', f'{secs}', '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', out)

def nearblocks_clip(out, secs, cap):
    src = f'{V}/shots/02b-nearblocks-charter.jpg'
    vf = (f"crop=910:470:538:190,scale=-2:860:flags=lanczos,pad=1920:1080:(ow-iw)/2:40:color=0x120b07,"
          f"zoompan=z='min(zoom+0.0006,1.06)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps={FPS},{caption(cap)},format=yuv420p")
    run('-framerate', str(FPS), '-loop', '1', '-t', f'{secs}', '-i', src, '-vf', vf, '-frames:v', str(round(secs * FPS)), '-c:v', 'libx264', '-crf', '17', out)

def end_clip(out, secs):
    vf = (f"scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,eq=brightness=-0.32:saturation=0.8,"
          f"drawtext=fontfile={SERIF}:text='Bazaar Sovereign':fontsize=110:fontcolor=0xf0bd45:x=(w-tw)/2:y=330,"
          f"drawtext=fontfile={SANS}:text='Every merchant is an NFT that owns its own NEAR wallet':fontsize=40:fontcolor=0xf3e6cc:x=(w-tw)/2:y=480,"
          f"drawtext=fontfile={SANS}:text='Play free\\: bazaar.reconscribe.com':fontsize=56:fontcolor=white:x=(w-tw)/2:y=600,"
          f"drawtext=fontfile={SANS}:text='Built on NEAR testnet · NEAR Hackathon 2026':fontsize=32:fontcolor=0xcbb894:x=(w-tw)/2:y=700,format=yuv420p")
    bg = 'art-src/cine/clips/trailer-end.mp4'   # the closing bazaar, camera rising to the stars, under the title
    if os.path.exists(bg):
        k = max(1.0, secs / dur(bg))
        run('-i', bg, '-an', '-vf', f'setpts={k:.4f}*PTS,fps={FPS},' + vf, '-frames:v', str(round(secs * FPS)), '-c:v', 'libx264', '-crf', '17', out)
    else:
        run('-framerate', str(FPS), '-loop', '1', '-t', f'{secs}', '-i', 'public/art/bazaar.webp', '-vf', vf, '-frames:v', str(round(secs * FPS)), '-c:v', 'libx264', '-crf', '17', out)

# lay out the timeline: each segment lasts its narration + a breath; shots split it evenly
starts, clips, vo_parts, t = [], [], [], 0.0
seg_start = {}
for sid, cap, shots in SEGMENTS:
    d = dur(f'{V}/vo/{sid}.wav'); total = d + (2.8 if sid == 's8' else GAP)
    seg_start[sid] = t
    weights = [1.0 if s[0] != 'intro' else 0 for s in shots]
    intro_len = 2.4 if shots[0][0] == 'intro' else 0   # a short title: judges should see the game within 3 s
    each = (total - intro_len) / max(1, sum(weights))
    for s in shots:
        length = intro_len if s[0] == 'intro' else each
        starts.append(t); clips.append((s, length, cap)); t += length
    vo_parts.append((sid, d, total))
END = t

files = []
for i, ((s, length, cap), st) in enumerate(zip(clips, starts)):
    last = i == len(clips) - 1
    secs = length + (0 if last else XF)          # overlap into the next shot for the crossfade
    out = f'{T}/c{i:02d}.mp4'
    kind = s[0]
    if kind == 'intro': intro_clip(out, secs)
    elif kind == 'still': still_clip(out, secs, s[1], s[2], s[3], s[4], cap)
    elif kind == 'clip': motion_clip(out, secs, marks[s[1]], s[2], s[3], cap)
    elif kind == 'cine': cine_clip(out, secs, s[1], cap)
    elif kind == 'nearblocks': nearblocks_clip(out, secs, cap)
    elif kind == 'end': end_clip(out, secs)
    files.append(out); print(f'{out} {kind} {secs:.2f}s at {st:.2f}s')

# crossfade chain
inputs = sum([['-i', f] for f in files], [])
fc, prev = [], '0:v'
for i in range(1, len(files)):
    lab = f'v{i}'
    fc.append(f'[{prev}][{i}:v]xfade=transition=fade:duration={XF}:offset={starts[i]:.3f}[{lab}]')
    prev = lab
run(*inputs, '-filter_complex', ';'.join(fc), '-map', f'[{prev}]', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', f'{T}/video.mp4')

# narration placed at each segment start (the intro gets a short lead-in)
vo_inputs, vo_fc = [], []
for k, (sid, d, total) in enumerate(vo_parts):
    vo_inputs += ['-i', f'{V}/vo/{sid}.wav']
    lead = 0.6 if sid == 's1' else 0.15
    vo_fc.append(f'[{k}]aresample=48000,adelay={int((seg_start[sid] + lead) * 1000)}|{int((seg_start[sid] + lead) * 1000)}[a{k}]')
vo_fc.append(''.join(f'[a{k}]' for k in range(len(vo_parts))) + f'amix=inputs={len(vo_parts)}:normalize=0,apad,atrim=0:{END:.3f}[vo]')
run(*vo_inputs, '-filter_complex', ';'.join(vo_fc), '-map', '[vo]', '-ac', '2', f'{T}/vo.wav')

# music: bazaar theme, the magnate's theme from his arrival, the finale for the last segment
m1, m2 = seg_start['s5'], seg_start['s8']
run('-i', 'public/audio/music/bazaar.mp3', '-i', 'public/audio/music/magnate.mp3', '-i', 'public/audio/music/finale.mp3', '-filter_complex',
    f"[0]atrim=0:{m1:.3f},afade=t=in:d=0.6,afade=t=out:st={m1 - 1:.3f}:d=1[a];"
    f"[1]atrim=0:{m2 - m1:.3f},afade=t=in:d=1,afade=t=out:st={m2 - m1 - 1:.3f}:d=1[b];"
    f"[2]atrim=0:{END - m2:.3f},afade=t=in:d=0.8,afade=t=out:st={END - m2 - 1.5:.3f}:d=1.5[c];"
    f"[a][b][c]concat=n=3:v=0:a=1,volume=0.24,aresample=48000[m]", '-map', '[m]', '-ac', '2', f'{T}/music.wav')

run('-i', f'{T}/video.mp4', '-i', f'{T}/vo.wav', '-i', f'{T}/music.wav', '-filter_complex',
    '[2][1]sidechaincompress=threshold=0.04:ratio=6:attack=20:release=400[duck];[duck][1]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]',
    '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'pcm_s16le', '-shortest', f'{T}/mixed.mkv')
run('-i', f'{T}/mixed.mkv', '-c:v', 'copy', '-af', 'loudnorm=I=-15:TP=-1.5:LRA=7', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', f'{V}/bazaar-sovereign-demo.mp4')
print(f'done: {V}/bazaar-sovereign-demo.mp4 {dur(V + "/bazaar-sovereign-demo.mp4"):.1f}s')
