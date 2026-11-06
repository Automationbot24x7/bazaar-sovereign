# Cuts the key-green sprite sheets from tools/gen-sprites.mjs into transparent sprites.
# Figures sit in one row with gaps, so empty columns split them; each sprite is trimmed,
# de-spilled (green fringe pulled to neutral), scaled to a fixed height and saved as WebP with alpha.
# Usage: python tools/cut-sprites.py   (reads art-src/sprites/*.png, writes public/art/sprites/<sheet>-<n>.webp + index.json)
import json, os, sys
from PIL import Image, ImageFilter

SRC, OUT = 'art-src/sprites', 'public/art/sprites'
HEIGHT = {'townsfolk': 220, 'camels': 260, 'magnate': 260}
os.makedirs(OUT, exist_ok=True)

def key_mask(img):
    """Alpha from greenness: pixels where green clearly dominates red and blue become transparent."""
    r, g, b = img.split()
    px_r, px_g, px_b = r.load(), g.load(), b.load()
    w, h = img.size
    a = Image.new('L', (w, h)); pa = a.load()
    for y in range(h):
        for x in range(w):
            gr, rr, bb = px_g[x, y], px_r[x, y], px_b[x, y]
            d = gr - max(rr, bb)              # how much greener than the other channels
            pa[x, y] = 0 if d > 70 else 255 if d < 25 else int(255 * (70 - d) / 45)
    return a

def despill(img):
    """Clamp green to the larger of red/blue so the edge fringe loses its green cast."""
    px = img.load(); w, h = img.size
    for y in range(h):
        for x in range(w):
            R, G, B = px[x, y]
            m = max(R, B)
            if G > m: px[x, y] = (R, m, B)
    return img

def columns(alpha, min_gap=6, min_w=30):
    w, h = alpha.size
    col = alpha.resize((w, 1), Image.BOX).load()       # mean alpha per column
    runs, start, gap = [], None, 0
    for x in range(w):
        on = col[x, 0] > 2
        if on:
            if start is None: start = x
            gap = 0
        elif start is not None:
            gap += 1
            if gap >= min_gap:
                if x - gap - start >= min_w: runs.append((start, x - gap + 1))
                start, gap = None, 0
    if start is not None and w - start >= min_w: runs.append((start, w))
    return runs

index = {}
for sheet in sorted(f[:-4] for f in os.listdir(SRC) if f.endswith('.png')):
    if len(sys.argv) > 1 and sheet not in sys.argv[1:]: continue
    img = Image.open(f'{SRC}/{sheet}.png').convert('RGB')
    alpha = key_mask(img).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.6))
    rgba = despill(img).convert('RGBA'); rgba.putalpha(alpha)
    parts = []
    for x0, x1 in columns(alpha):
        part = rgba.crop((x0, 0, x1, img.height))
        bbox = part.getchannel('A').point(lambda v: 255 if v > 24 else 0).getbbox()
        if not bbox: continue
        part = part.crop(bbox)
        if part.height < img.height * 0.1: continue       # stray specks
        parts.append((part, bbox[3]))
    # one scale per sheet: the tallest figure gets HEIGHT, the rest keep their size relative to it (a child stays small)
    k = HEIGHT.get(sheet, 220) / max(p.height for p, _ in parts)
    out = []
    for part, _ in parts:
        part = part.resize((max(1, round(part.width * k)), max(1, round(part.height * k))), Image.LANCZOS)
        name = f'{sheet}-{len(out) + 1}'
        part.save(f'{OUT}/{name}.webp', 'WEBP', quality=88, method=6)
        out.append({'src': f'/art/sprites/{name}.webp', 'w': part.width, 'h': part.height})
    index[sheet] = out
    print(sheet, len(out), [o['w'] for o in out])

prev = json.load(open(f'{OUT}/index.json')) if os.path.exists(f'{OUT}/index.json') else {}
prev.update(index)
json.dump(prev, open(f'{OUT}/index.json', 'w'), indent=1)
