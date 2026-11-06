// Generates the game's art with Gemini (Nano Banana Pro).
// Usage: GEMINI_KEY_FILE=path/to/key.txt node tools/gen-art.mjs [only-name]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const key = process.env.GEMINI_API_KEY || readFileSync(process.env.GEMINI_KEY_FILE, 'utf8').trim();
const MODEL = process.env.IMAGE_MODEL || 'gemini-3-pro-image';
const OUT = 'public/art';
mkdirSync(OUT, { recursive: true });

const STYLE = 'Rich storybook illustration in gouache and ink, inspired by Persian and Mughal miniature painting but original, warm saffron, terracotta, indigo and teal palette, soft golden-hour light, fine linework, subtle paper texture. No text, no letters, no watermark, no border.';
const PORTRAIT = 'Bust portrait, character facing slightly left, centered, plain warm parchment-toned background with a faint arch shape behind the head, game character card art, consistent style.';

const JOBS = [
  { name: 'player', ratio: '1:1', prompt: `${PORTRAIT} A young ambitious merchant heir in a deep indigo robe with gold trim and a saffron turban, confident half-smile, holding a small brass ledger. ${STYLE}` },
  { name: 'teodora', ratio: '1:1', prompt: `${PORTRAIT} An elderly, kind but shrewd tea-and-salt trader woman with silver braids, green shawl, reading spectacles on a chain, weathered hands around a clay tea cup. ${STYLE}` },
  { name: 'kasim', ratio: '1:1', prompt: `${PORTRAIT} A wiry, fast-talking young market hawker with a red headscarf, mischievous grin, gesturing mid-shout, coins tucked behind his ear. ${STYLE}` },
  { name: 'vey', ratio: '1:1', prompt: `${PORTRAIT} An elegant aristocratic silk merchant woman in layered violet and silver silks, pearl earrings, one raised eyebrow, a bolt of shimmering silk over her shoulder. ${STYLE}` },
  { name: 'ozzo', ratio: '1:1', prompt: `${PORTRAIT} A large, scheming bearded monk-turned-merchant in a blue hooded robe, rings on every finger, narrowed knowing eyes, a secret note half-hidden in his sleeve. ${STYLE}` },
  { name: 'saffron', ratio: '1:1', prompt: `Game item icon: a small woven basket overflowing with crimson saffron threads and purple crocus flowers, centered on a plain parchment background, soft shadow. ${STYLE}` },
  { name: 'silk', ratio: '1:1', prompt: `Game item icon: neatly folded bolts of iridescent violet and gold silk with a tassel, centered on a plain parchment background, soft shadow. ${STYLE}` },
  { name: 'tea', ratio: '1:1', prompt: `Game item icon: a burlap sack of dark green tea leaves with a brass scoop, centered on a plain parchment background, soft shadow. ${STYLE}` },
  { name: 'salt', ratio: '1:1', prompt: `Game item icon: rough pink and white rock-salt blocks tied with rope, centered on a plain parchment background, soft shadow. ${STYLE}` },
  { name: 'bazaar', ratio: '16:9', prompt: `Wide panoramic establishing shot of a bustling desert-city bazaar at dusk: five colorful merchant stalls under striped awnings in a row, lanterns being lit, spice pyramids, silk hanging, camels and townsfolk in the distance, a domed palace on the horizon. Leave the lower third calm and slightly darker for UI overlay. ${STYLE}` },
  { name: 'ruin', ratio: '1:1', prompt: `Game item icon: a torn merchant charter scroll with a broken wax seal and scattered coins, dramatic shadow, centered on a plain parchment background. ${STYLE}` },
];

async function gen(job) {
  const file = `${OUT}/${job.name}.png`;
  if (existsSync(file) && !process.argv[2]) return `skip ${job.name}`;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: job.prompt }] }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: job.ratio, imageSize: job.ratio === '16:9' ? '2K' : '1K' } },
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${job.name}: ${j.error?.message || r.status}`);
  const part = j.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
  if (!part) throw new Error(`${job.name}: no image returned`);
  writeFileSync(file, Buffer.from(part.inlineData.data, 'base64'));
  return `ok ${job.name}`;
}

const only = process.argv[2];
const jobs = JOBS.filter(j => !only || j.name === only);
for (let i = 0; i < jobs.length; i += 4) {
  const res = await Promise.allSettled(jobs.slice(i, i + 4).map(gen));
  for (const r of res) console.log(r.status === 'fulfilled' ? r.value : `FAIL ${r.reason.message}`);
}
