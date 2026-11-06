// End-to-end smoke test against a running server: play a few days, haggle with a rival,
// close a deal at their counter-offer, then print the on-chain feed.
// Usage: node tools/smoke.mjs [baseUrl]
const BASE = process.argv[2] || 'http://localhost:3000';
let cookie = '';
async function api(path, body) {
  const r = await fetch(BASE + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
  return r.json();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

let s = await api('/api/state');
console.log(`table: ${s.table} · chain: ${s.chain.mode}`);
s = await api('/api/simulate', { days: 6 });
console.log(`day ${s.day}`);

const spare = m => Object.entries(m.inventory).map(([g, q]) => [g, q]).filter(([, q]) => q >= 4).sort((a, b) => b[1] - a[1])[0];
const rival = s.merchants.find(m => !m.player && m.trading && spare(m));
if (!rival) { console.log('no rival with spare stock yet'); process.exit(0); }
const [good, held] = spare(rival);
const qty = Math.min(5, held), market = s.goods.find(g => g.id === good).price;
let price = +(market * 0.7).toFixed(2), deal = null;
for (let round = 1; round <= 4 && !deal; round++) {
  const r = await api('/api/offer', { target: rival.id, kind: 'goods', good, qty, price });
  if (r.error) { console.log('offer error:', r.error); break; }
  console.log(`round ${round}: ${qty} ${good} @ ${price} → ${r.reply.accept ? 'ACCEPTED' : 'rejected'} — ${rival.name}: "${r.reply.bark}"${r.reply.counter ? ` (counter ${r.reply.counter})` : ''}`);
  if (r.reply.accept) deal = r;
  else price = r.reply.counter || +(price * 1.15).toFixed(2);
  await sleep(2600);
}
if (deal) {
  console.log('waiting for chain…');
  for (let i = 0; i < 20; i++) { s = await api('/api/state'); if (!s.chain.pending) break; await sleep(2000); }
  for (const f of s.chainFeed.filter(f => ['deal', 'pay', 'loan', 'error'].includes(f.kind)).slice(0, 4)) console.log(` ${f.kind}: ${f.text} ${f.url || f.hash || ''}`);
}
