// Dev helper: print a compact summary of the running game. Usage: node tools/peek.mjs [port] [--feed]
const port = process.argv.find(a => /^\d+$/.test(a)) || 3000;
const j = await fetch(`http://localhost:${port}/api/state`).then(r => r.json());
console.log(`day ${j.day} | chain ${j.chain.mode} pending ${j.chain.pending ?? '-'} | ai ${j.ai}`);
for (const m of j.merchants) console.log(`  ${m.name.padEnd(16)} ${String(m.netWorth).padStart(6)}g ${m.bankrupt ? 'BANKRUPT' : ''}${m.ownedBy ? ' owned-by:' + m.ownedBy : ''} | ${m.modelLabel || ''} ${m.thinkMs ? (m.thinkMs / 1000).toFixed(1) + 's' : ''} | ${m.doctrine.stance}${m.doctrine.focus ? ':' + m.doctrine.focus : ''} | ${m.bark || ''}`);
const errs = j.chainFeed.filter(f => f.kind === 'error');
console.log(`chain feed ${j.chainFeed.length} entries, ${errs.length} errors`);
for (const e of errs.slice(0, 3)) console.log('  ERR', e.text.slice(0, 160));
if (process.argv.includes('--feed')) for (const f of j.chainFeed.slice(0, 15)) console.log(`  ${f.kind.padEnd(8)} ${f.text.slice(0, 110)} ${f.url || ''}`);
if (j.aiStats) console.log('ai stats', JSON.stringify(j.aiStats));
