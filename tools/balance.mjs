// Balance harness: plays many seasons with scripted player strategies against the rivals'
// offline (heuristic) brains and reports win rates. No network, no API keys.
// Usage: node tools/balance.mjs [seasons]
import { createWorld, step, acceptContract, standings, netWorth } from '../server/engine.js';
import { think } from '../server/brains.js';
import { ROSTER_FOR_TESTS as ROSTER } from './roster.mjs';

const SEASONS = Number(process.argv[2] || 40);
const STRATS = {
  passive: () => {},
  undercut: (w, me) => { me.doctrine = { stance: 'undercut', focus: null, aggression: 0.6 }; },
  premium: (w, me) => { me.doctrine = { stance: 'premium', focus: null, aggression: 0.6 }; },
  rumorCorner: (w, me) => {
    const s = w.pending?.supply && Object.entries(w.pending.supply).find(([, v]) => v < 1);
    if (s) me.doctrine = { stance: 'corner', focus: s[0], aggression: 0.8 };
    else if (w.pending?.demand) me.doctrine = { stance: 'hoard', focus: null, aggression: 0.6 };
    else if (!w.active.length) me.doctrine = { stance: 'steady', focus: null, aggression: 0.5 };
  },
  palaceChaser: (w, me) => {
    const c = w.contracts.find(c => c.status === 'open' && !c.takenBy);
    if (c && !w.contracts.some(x => x.status === 'open' && x.takenBy === me.id)) acceptContract(w, me, c.id);
    const mine = w.contracts.find(x => x.status === 'open' && x.takenBy === me.id);
    me.doctrine = mine ? { stance: 'corner', focus: mine.good, aggression: 0.8 } : { stance: 'steady', focus: null, aggression: 0.5 };
  },
};

const out = {};
for (const [name, play] of Object.entries(STRATS)) {
  const r = { wins: 0, rank: 0, bankrupt: 0, rivalBankrupt: 0, worth: 0, best: {} };
  for (let s = 1; s <= SEASONS; s++) {
    const w = createWorld({ seed: s * 7919, merchants: ROSTER.map(x => ({ ...x })) });
    const me = w.merchants.find(m => m.player);
    while (!w.over) {
      // rivals react first (in the live game they answer within seconds of a new order or rumor)
      const openOrder = w.contracts.some(c => c.status === 'open' && !c.takenBy);
      for (const m of w.merchants.filter(m => !m.player && !m.bankrupt && !m.ownedBy)) {
        if ((w.day + m.id.length) % 4 === 0 || w.pending || openOrder) {
          const d = await think(w, { ...m, _offline: true });
          m.doctrine = { stance: d.stance, focus: d.focus, aggression: d.aggression };
          if (d.claim) { const c = w.contracts.find(c => c.status === 'open' && !c.takenBy); if (c) acceptContract(w, m, c.id); }
        }
      }
      play(w, me);
      step(w);
    }
    const t = standings(w), rank = t.findIndex(x => x.id === 'you') + 1;
    r.wins += w.result.win ? 1 : 0; r.rank += rank; r.bankrupt += me.bankrupt ? 1 : 0;
    r.rivalBankrupt += w.merchants.filter(m => !m.player && m.bankrupt).length;
    r.worth += netWorth(w, me);
    r.best[t[0].id] = (r.best[t[0].id] || 0) + 1;
  }
  out[name] = { winRate: `${Math.round((r.wins / SEASONS) * 100)}%`, avgRank: (r.rank / SEASONS).toFixed(2), avgWorth: Math.round(r.worth / SEASONS), youBankrupt: r.bankrupt, rivalBankruptcies: r.rivalBankrupt, richestCounts: r.best };
}
console.table(out);
