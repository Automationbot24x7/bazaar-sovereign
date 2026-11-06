// Voice-over for the demo video (Gemini TTS), one WAV per line in art-src/video/vo/.
// Shares the spend ledger and budget cap with tools/gen-audio.mjs.
// Usage: GEMINI_KEY_FILE=path/to/key.txt node tools/video/gen-narration.mjs [--force]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const key = process.env.GEMINI_API_KEY || readFileSync(process.env.GEMINI_KEY_FILE, 'utf8').trim();
const BUDGET = Number(process.env.AUDIO_BUDGET_USD || 9.5), LEDGER = 'art-src/audio-spend.json', OUT = 'art-src/video/vo';
const { voice, style, lines } = JSON.parse(readFileSync('tools/video/narration.json', 'utf8'));
const ledger = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : { usd: 0, calls: [] };
mkdirSync(OUT, { recursive: true });

for (const line of lines) {
  const file = `${OUT}/${line.id}.wav`;
  if (existsSync(file) && !process.argv.includes('--force')) continue;
  if (ledger.usd + 0.01 > BUDGET) throw new Error(`Budget stop at $${ledger.usd}`);
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Api-Revision': '2026-05-20', 'x-goog-api-key': key },
    body: JSON.stringify({
      model: 'gemini-3.8-flash-tts',
      input: [{ type: 'user_input', content: [{ type: 'text', text: line.text, annotations: [{ type: 'speech_metadata', style }] }] }],
      response_format: { type: 'audio' }, generation_config: { speech_config: [{ voice }] },
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
  const audio = j.steps.flatMap(s => s.content || []).find(c => c.type === 'audio');
  const data = Buffer.from(audio.data, 'base64');
  writeFileSync(file, data);
  const usd = (j.usage?.total_input_tokens || 0) * 0.5e-6 + (j.usage?.total_output_tokens || 0) * 9e-6;
  ledger.usd = +(ledger.usd + usd).toFixed(4); ledger.calls.push({ what: `narration ${line.id}`, usd: +usd.toFixed(4), at: new Date().toISOString() });
  writeFileSync(LEDGER, JSON.stringify(ledger, null, 1));
  console.log(`${line.id} ${((data.length - 44) / 48000).toFixed(1)}s · total $${ledger.usd}`);
}
