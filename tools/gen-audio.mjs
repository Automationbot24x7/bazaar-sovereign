// Generates the voiced scene lines (Gemini TTS) and the music (Lyria) listed in public/scenes.json.
// One-off: the files are shipped with the game, so playing costs nothing.
// Usage: GEMINI_KEY_FILE=path/to/key.txt node tools/gen-audio.mjs [voices|music|all] [--force]
// WAV voice lines are written to WAV_DIR; convert them to MP3 with tools/encode-audio.sh.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const key = process.env.GEMINI_API_KEY || readFileSync(process.env.GEMINI_KEY_FILE, 'utf8').trim();
const BUDGET = Number(process.env.AUDIO_BUDGET_USD || 9.5);
const LEDGER = process.env.AUDIO_LEDGER || 'art-src/audio-spend.json';
const WAV_DIR = process.env.WAV_DIR || 'art-src/voice-wav';
const what = process.argv[2] || 'all', force = process.argv.includes('--force');
const { cast, scenes, music } = JSON.parse(readFileSync('public/scenes.json', 'utf8'));
const ledger = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : { usd: 0, calls: [] };
mkdirSync(WAV_DIR, { recursive: true }); mkdirSync('art-src/music-src', { recursive: true }); mkdirSync('public/audio/lines', { recursive: true });

const PRICE = { tts: { in: 0.5e-6, audio: 9e-6 }, lyria: 0.08 }; // USD, Gemini 3.8 Flash TTS launch pricing; Lyria 3.5 per track
const spend = (usd, what) => { ledger.usd = +(ledger.usd + usd).toFixed(4); ledger.calls.push({ what, usd: +usd.toFixed(4), at: new Date().toISOString() }); writeFileSync(LEDGER, JSON.stringify(ledger, null, 1)); };
const guard = est => { if (ledger.usd + est > BUDGET) throw new Error(`Budget stop: spent $${ledger.usd}, next call ~$${est}, cap $${BUDGET}`); };

async function interact(body) {
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Api-Revision': '2026-05-20', 'x-goog-api-key': key }, body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
  const audio = j.steps?.flatMap(s => s.content || []).find(c => c.type === 'audio');
  if (!audio) throw new Error('no audio in response');
  return { data: Buffer.from(audio.data, 'base64'), usage: j.usage || {} };
}

if (what === 'voices' || what === 'all') {
  for (const [scene, lines] of Object.entries(scenes)) {
    for (const [i, line] of lines.entries()) {
      const name = `${scene}-${i + 1}`, wav = `${WAV_DIR}/${name}.wav`;
      if (existsSync(wav) && !force) continue;
      const who = cast[line.who];
      guard(0.01);
      const { data, usage } = await interact({
        model: 'gemini-3.8-flash-tts',
        input: [{ type: 'user_input', content: [{ type: 'text', text: line.text, annotations: [{ type: 'speech_metadata', style: line.style || who.style }] }] }],
        response_format: { type: 'audio' },
        generation_config: { speech_config: [{ voice: who.voice }] },
      });
      writeFileSync(wav, data);
      const usd = (usage.total_input_tokens || 0) * PRICE.tts.in + (usage.total_output_tokens || 0) * PRICE.tts.audio;
      spend(usd, `tts ${name}`);
      console.log(`voice ${name} (${who.name}) ${(data.length / 48000).toFixed(1)}s $${usd.toFixed(4)} · total $${ledger.usd}`);
    }
  }
}

if (what === 'music' || what === 'all') {
  for (const [name, m] of Object.entries(music)) {
    const out = `art-src/music-src/${name}.mp3`; // slimmed into public/audio/music by tools/encode-audio.sh
    if (existsSync(out) && !force) continue;
    guard(PRICE.lyria);
    const { data } = await interact({ model: 'lyria-3.5', input: m.prompt, response_format: { type: 'audio' } });
    writeFileSync(out, data);
    spend(PRICE.lyria, `lyria ${name}`);
    console.log(`music ${name} ${(data.length / 1024).toFixed(0)} KB · total $${ledger.usd}`);
  }
}
console.log(`Spent so far: $${ledger.usd} of $${BUDGET}`);
