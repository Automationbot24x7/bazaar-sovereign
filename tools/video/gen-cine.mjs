// Cinematics through SandBase: new scene stills (Nano Banana 2.1 Edit, in the bazaar's painted style),
// then image-to-video clips (Kling) for the in-game story scenes, speaking portraits and trailer shots.
// Plan: tools/video/cine.json. Progress is saved to art-src/cine/manifest.json, so a re-run never pays twice.
// Usage: node tools/video/gen-cine.mjs [stills|clips|all] [only-name...]
// Key: SANDBASE_API_KEY, or Credentials/sandbase-key.txt (never committed).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const KEY = process.env.SANDBASE_API_KEY || readFileSync('Credentials/sandbase-key.txt', 'utf8').trim();
const API = 'https://api.sandbase.ai/v1';
const OUT = 'art-src/cine', MANIFEST = `${OUT}/manifest.json`;
const CAP_USD = Number(process.env.CINE_CAP_USD || 20);       // stop before spending more than this in total
mkdirSync(`${OUT}/stills`, { recursive: true }); mkdirSync(`${OUT}/clips`, { recursive: true });

const plan = JSON.parse(readFileSync('tools/video/cine.json', 'utf8'));
const man = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : { usd: 0, stills: {}, clips: {} };
const save = () => writeFileSync(MANIFEST, JSON.stringify(man, null, 1));
const what = process.argv[2] || 'all', only = process.argv.slice(3);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MODELS = { kling30: 'kwaivgi/kling-video/3.0/omni/pro/image-to-video', kling25: 'kwaivgi/kling-video/v2.5-turbo/pro/image-to-video' };
const PRICE = { still: 0.066, kling30: 0.56, kling25: 0.35 };   // 2K edit with up to 3 refs; 5 s clips

async function api(method, path, body) {
  const r = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, j };
}
// submit (waiting out the 2-job concurrency limit), then poll until done
async function run(body, label) {
  let sub;
  for (let i = 0; i < 120; i++) {
    sub = await api('POST', '/run', body);
    if (sub.ok && sub.j.id) break;
    if (/concurrency|rate limit/i.test(sub.j.error || '')) { await sleep(10000); continue; }
    throw new Error(`${label}: submit failed ${sub.status} ${JSON.stringify(sub.j).slice(0, 200)}`);
  }
  const id = sub.j.id;
  for (let i = 0; i < 200; i++) {
    await sleep(8000);
    const g = await api('GET', `/run/${id}`);
    const st = g.j.status;
    if (st === 'completed') return { id, url: g.j.outputs?.[0]?.url };
    if (st === 'failed' || st === 'timeout') throw new Error(`${label}: ${st} ${JSON.stringify(g.j.error || '').slice(0, 200)}`);
  }
  throw new Error(`${label}: still running after ~27 min`);
}
async function download(url, file) {
  const r = await fetch(url); if (!r.ok) throw new Error(`download ${r.status} ${url}`);
  writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}
const guard = usd => { if (man.usd + usd > CAP_USD) throw new Error(`Budget stop: spent $${man.usd.toFixed(2)}, next ~$${usd}, cap $${CAP_USD}`); };
const imageUrl = ref => {
  const [kind, name] = ref.split(':');
  if (kind === 'ref') return plan.refs[name];
  const s = man.stills[name]; if (!s?.url) throw new Error(`still "${name}" is not made yet`); return s.url;
};

async function pool(items, n, fn) {
  const q = [...items], errs = [];
  await Promise.all(Array.from({ length: n }, async () => { while (q.length) { const it = q.shift(); try { await fn(it); } catch (e) { errs.push(e.message); console.log('FAIL', e.message); } } }));
  return errs;
}

if (what === 'stills' || what === 'all') {
  const todo = Object.entries(plan.stills).filter(([k]) => !man.stills[k] && (!only.length || only.includes(k)));
  await pool(todo, 2, async ([name, s]) => {
    guard(PRICE.still);
    const body = { model: 'google/nano-banana-2.1/edit', prompt: `${s.prompt}\n\n${plan.style}`, images: s.refs.map(r => plan.refs[r]), aspect_ratio: s.ratio, resolution: '2K' };
    const r = await run(body, `still ${name}`);
    const file = `${OUT}/stills/${name}.png`; await download(r.url, file);
    man.stills[name] = { ...r, file }; man.usd += PRICE.still; save();
    console.log(`still ${name} ok · total $${man.usd.toFixed(2)}`);
  });
}

if (what === 'clips' || what === 'all') {
  const todo = Object.entries(plan.clips).filter(([k]) => !man.clips[k] && (!only.length || only.includes(k)));
  await pool(todo, 2, async ([name, c]) => {
    guard(PRICE[c.model]);
    const image = imageUrl(c.image);
    const body = { model: MODELS[c.model], prompt: c.prompt, image, duration: 5, ...(c.loop ? { end_image: image } : {}) };
    const r = await run(body, `clip ${name}`);
    const file = `${OUT}/clips/${name}.mp4`; await download(r.url, file);
    man.clips[name] = { ...r, file, model: c.model }; man.usd += PRICE[c.model]; save();
    console.log(`clip ${name} ok · total $${man.usd.toFixed(2)}`);
  });
}
console.log(`done · spent this plan $${man.usd.toFixed(2)}`);
