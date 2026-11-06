// Generates the walking figures for the living bazaar (townsfolk, camels, the Magnate's wagon) as sprite sheets
// on a flat key-green background; tools/cut-sprites.py then cuts them out into transparent sprites.
// Usage: GEMINI_KEY_FILE=path/to/key.txt node tools/gen-sprites.mjs [only-name]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const key = process.env.GEMINI_API_KEY || readFileSync(process.env.GEMINI_KEY_FILE, 'utf8').trim();
const MODEL = process.env.IMAGE_MODEL || 'gemini-3-pro-image';
const OUT = 'art-src/sprites', SPEND = 'art-src/audio-spend.json', USD = 0.134;
mkdirSync(OUT, { recursive: true });

const STYLE = 'Rich storybook illustration in gouache and ink, inspired by Persian and Mughal miniature painting but original, warm saffron, terracotta, indigo and plum palette, soft golden-hour light, fine dark ink outlines, subtle paper texture. No text, no letters, no watermark, no border.';
const SHEET = 'Game sprite sheet. Every figure in full body, strict side profile, facing and walking toward the RIGHT, mid-stride, all at the same scale, standing on the same invisible baseline, in ONE horizontal row with wide empty gaps between them so no two figures touch or overlap. The background is a perfectly flat, uniform, pure chroma-key green (#00FF00) with no ground, no floor line, no cast shadows, no scenery and no gradient. The figures themselves contain no green at all.';

const JOBS = [
  { name: 'townsfolk', prompt: `${SHEET} Six different townsfolk of a desert-city bazaar: a porter in a brown tunic carrying a heavy sack on his shoulder; a woman in a terracotta dress and indigo headscarf carrying a woven basket; an old man in a white turban and cream robe walking with a cane; a small child in a saffron tunic; a noblewoman in plum and gold silks with a veil; a water-seller with a big brass jug on his back. ${STYLE}` },
  { name: 'camels', prompt: `${SHEET} Three figures: a camel laden with rolled bolts of colorful silk and rope-tied bundles; a camel carrying a rider in an indigo robe and turban; a camel driver in a saffron robe walking on foot. ${STYLE}` },
  { name: 'magnate', prompt: `${SHEET} Three figures: an ornate black-and-gold merchant wagon with a golden canopy, large spoked wheels and crimson pennants, piled with crates, pulled by a camel in gold harness, a driver in black-and-gold livery on the bench; a porter in black-and-gold livery carrying a wooden crate; a second porter in black-and-gold livery pushing a small two-wheeled handcart of sacks. ${STYLE}` },
];

async function gen(job) {
  const file = `${OUT}/${job.name}.png`;
  if (existsSync(file) && !process.argv[2]) return `skip ${job.name}`;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: job.prompt }] }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '21:9', imageSize: '2K' } },
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${job.name}: ${j.error?.message || r.status}`);
  const part = j.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
  if (!part) throw new Error(`${job.name}: no image returned`);
  writeFileSync(file, Buffer.from(part.inlineData.data, 'base64'));
  const s = existsSync(SPEND) ? JSON.parse(readFileSync(SPEND, 'utf8')) : { usd: 0, calls: [] };
  s.usd = Math.round((s.usd + USD) * 1e4) / 1e4; s.calls.push({ what: `sprites ${job.name}`, usd: USD, at: new Date().toISOString() });
  writeFileSync(SPEND, JSON.stringify(s, null, 1));
  return `ok ${job.name}`;
}

const only = process.argv[2];
const res = await Promise.allSettled(JOBS.filter(j => !only || j.name === only).map(gen));
for (const r of res) console.log(r.status === 'fulfilled' ? r.value : `FAIL ${r.reason.message}`);
