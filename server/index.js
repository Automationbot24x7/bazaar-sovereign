import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { GOODS, STANCES, createWorld, step, netWorth, takeover, takeoverPrice } from './engine.js';
import { think, interpretOrder, aiOn } from './brains.js';
import * as chain from './chain.js';

const PORT = process.env.PORT || 3000;
const SETTLE_EVERY = 5;
const PLAYER_OWNER = process.env.PLAYER_ACCOUNT_ID || process.env.NEAR_ACCOUNT_ID || 'you.mock';
const VIZIER = process.env.NEAR_ACCOUNT_ID || 'vizier.mock';

const ROSTER = [
  { id: 'you', slug: 'player', name: 'Your House', player: true, color: '#e0a526', persona: 'The player.' },
  { id: 'teodora', slug: 'teodora', name: 'Old Ma Teodora', color: '#5aa469', persona: 'Patient, cautious tea and salt trader with forty years in the bazaar. Hates debt, loves festivals, never panics.' },
  { id: 'kasim', slug: 'kasim', name: 'Kasim the Quick', color: '#d35d47', persona: 'Loud, fast undercutter who always sells cheaper than everyone. Thin margins, high volume, a little reckless.' },
  { id: 'vey', slug: 'vey', name: 'Lady Vey', color: '#8e6cc9', persona: 'Noble premium silk merchant. Refuses to compete on price; sells quality to the rich at high margins. Disdains Kasim.' },
  { id: 'ozzo', slug: 'ozzo', name: 'Brother Ozzo', color: '#3b8bd0', persona: 'Bold, greedy schemer who acts on every rumor and tries to corner whatever market is about to spike.' },
];

let world, running = false, speedMs = 1400, timer = null, thinking = new Set(), pnlBuffer = {};
const ownerOf = m => (m.player ? PLAYER_OWNER : VIZIER);

function newGame(seed = 7) {
  world = createWorld({ seed, merchants: ROSTER.map(r => ({ ...r })) });
  pnlBuffer = {};
  chain.setupMerchants(world.merchants, ownerOf).catch(e => console.error(e));
  for (const m of world.merchants.filter(m => !m.player)) npcThink(m);
}

function npcThink(m) {
  if (thinking.has(m.id) || m.bankrupt) return;
  thinking.add(m.id);
  think(world, m)
    .then(d => { m.doctrine = { stance: d.stance, focus: d.focus, aggression: d.aggression }; m.bark = d.bark; m.thought = d.thought; m.brain = d.engine; })
    .catch(e => { m.brain = 'error'; console.error(`think ${m.id}:`, e.message); })
    .finally(() => thinking.delete(m.id));
}

function tick() {
  const before = world.pending;
  const { settlement } = step(world);
  for (const r of settlement) pnlBuffer[r.merchant] = (pnlBuffer[r.merchant] || 0) + r.pnl;

  // NPCs re-think every 4 days (staggered) or immediately when a rumor/event appears.
  const fresh = (!before && world.pending) || world.news[0]?.kind === 'event';
  world.merchants.filter(m => !m.player).forEach((m, i) => { if (fresh || (world.day + i) % 4 === 0) npcThink(m); });

  // NPC vultures: a rich NPC buys a bankrupt charter if the player hasn't within 3 days.
  for (const t of world.merchants.filter(m => m.bankrupt && !m.ownedBy)) {
    t.bankruptDay ??= world.day;
    if (world.day - t.bankruptDay >= 3) {
      const buyer = world.merchants.filter(m => !m.bankrupt && !m.player && m.gold > takeoverPrice(world, t) * 2).sort((a, b) => b.gold - a.gold)[0];
      if (buyer) { const price = takeover(world, buyer, t); buyer.bark = `${t.name}'s stall is mine now.`; chain.recordTakeover(buyer, t, price, ownerOf(buyer)); }
    }
  }
  if (world.day % SETTLE_EVERY === 0) {
    chain.settle(world.day, Object.entries(pnlBuffer).map(([merchant, pnl]) => ({ merchant, pnl })), world.merchants);
    chain.updateCharters(world.day, world.merchants, m => netWorth(world, m));
    pnlBuffer = {};
  }
}

function loop() {
  clearTimeout(timer);
  if (!running) return;
  tick();
  timer = setTimeout(loop, speedMs);
}

function view() {
  return {
    day: world.day, running, speedMs, ai: aiOn() ? 'claude' : 'heuristic',
    chain: chain.chainInfo(),
    goods: GOODS.map(g => ({ ...g, price: world.prices[g.id], history: world.history[g.id].slice(-60) })),
    events: world.active.map(e => ({ text: e.text, left: e.left })),
    rumor: world.pending?.rumor || null,
    news: world.news.slice(0, 25),
    merchants: world.merchants.map(m => ({
      id: m.id, name: m.name, color: m.color, player: !!m.player, gold: Math.round(m.gold), netWorth: Math.round(netWorth(world, m)),
      inventory: m.inventory, lastPnl: Math.round(m.lastPnl), doctrine: m.doctrine, bark: m.bark, thought: m.thought, brain: m.brain,
      bankrupt: m.bankrupt, ownedBy: m.ownedBy || null, tokenId: m.tokenId, wallet: m.wallet, owner: ownerOf(m),
      netHistory: m.netHistory.slice(-60), lastAsk: m.lastAsk || {},
      takeoverPrice: m.bankrupt && !m.ownedBy ? takeoverPrice(world, m) : null, thinking: thinking.has(m.id),
    })),
    chainFeed: chain.feed.slice(0, 30),
  };
}

const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const body = req => new Promise(r => { let d = ''; req.on('data', c => (d += c)); req.on('end', () => { try { r(d ? JSON.parse(d) : {}); } catch { r({}); } }); });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg' };
const player = () => world.merchants.find(m => m.player);

http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  try {
    if (p === '/api/state') return send(res, 200, view());
    if (req.method === 'POST') {
      const b = await body(req);
      switch (p) {
        case '/api/play': running = true; loop(); return send(res, 200, view());
        case '/api/pause': running = false; clearTimeout(timer); return send(res, 200, view());
        case '/api/speed': speedMs = Math.max(150, Math.min(4000, Number(b.ms) || 1400)); return send(res, 200, view());
        case '/api/step': tick(); return send(res, 200, view());
        case '/api/simulate': {
          const days = Math.min(60, Number(b.days) || 30);
          running = false; clearTimeout(timer);
          for (let i = 0; i < days; i++) { tick(); await new Promise(r => setTimeout(r, 120)); }
          return send(res, 200, view());
        }
        case '/api/reset': running = false; clearTimeout(timer); newGame(Number(b.seed) || 7); return send(res, 200, view());
        case '/api/doctrine': {
          const me = player();
          if (!STANCES.includes(b.stance)) return send(res, 400, { error: 'bad stance' });
          me.doctrine = { stance: b.stance, focus: GOODS.some(g => g.id === b.focus) ? b.focus : null, aggression: Math.min(1, Math.max(0, Number(b.aggression ?? 0.5))) };
          return send(res, 200, view());
        }
        case '/api/order': {
          const me = player();
          if (!b.order?.trim()) return send(res, 400, { error: 'order required' });
          const d = await interpretOrder(world, me, b.order.trim());
          me.doctrine = { stance: d.stance, focus: d.focus, aggression: d.aggression };
          me.bark = d.bark; me.thought = d.thought;
          return send(res, 200, { ...view(), reply: d });
        }
        case '/api/takeover': {
          const me = player(), t = world.merchants.find(m => m.id === b.target);
          if (!t || t.ownedBy) return send(res, 400, { error: 'not available' });
          const price = takeover(world, me, t);
          chain.recordTakeover(me, t, price, PLAYER_OWNER);
          me.bark = `The ${t.name} charter is ours.`;
          return send(res, 200, view());
        }
      }
    }
    if (p === '/api/balances') return send(res, 200, await chain.balances(world.merchants));
    const file = join(process.cwd(), 'public', p === '/' ? 'index.html' : p.replace(/\.\./g, ''));
    const data = await readFile(file).catch(() => null);
    if (!data) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
}).listen(PORT, () => {
  newGame();
  console.log(`Bazaar Sovereign → http://localhost:${PORT}  | chain: ${chain.chainMode} | brains: ${aiOn() ? 'Claude' : 'heuristic'}`);
});
