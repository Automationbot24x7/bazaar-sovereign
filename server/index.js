import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  GOODS, STANCES, SEASON_DAYS, createWorld, openingNews, step, netWorth, trading, takeover, takeoverPrice,
  acceptContract, executeDeal, executeBuyout, buyoutValue, standings, chartersOwned, log, checkSeason, backroomDeals, TRIBUTE,
  hireHelpers, buyAwning, capacity, HELPER_WAGE, AWNING_COST,
} from './engine.js';
import { think, interpretOrder, answerOffer, aiOn, stats, MODEL_LABEL } from './brains.js';
import { makeChain, testnetAvailable } from './chain.js';

const PORT = process.env.PORT || 3000;
const SETTLE_EVERY = 5;
const MAX_GAMES = Number(process.env.MAX_GAMES || 150);
const IDLE_PAUSE_MS = 45_000;          // a game pauses when its tab stops polling
const GAME_TTL_MS = 30 * 60_000;       // and is forgotten after 30 idle minutes
const LIVE_LEASE_MS = 5 * 60_000;      // the live testnet table frees up after 5 idle minutes
const AI_MAX_INFLIGHT = Number(process.env.AI_MAX_INFLIGHT || 10);

export const ROSTER = [
  { id: 'you', slug: 'player', art: 'player', name: 'Your House', player: true, color: '#e0a526', persona: 'The player.', model: 'claude-haiku-5-5' },
  { id: 'teodora', slug: 'teodora', art: 'teodora', name: 'Teodora', color: '#5aa469', model: 'claude-sonnet-5-5',
    persona: 'An elderly tea and salt trader with forty years at the same stall. Patient and cautious, hates debt, loves festivals, never panics. Calls younger merchants "children".',
    profile: { bio: 'Forty years at the same tea-and-salt stall. Patient, debt-shy, and never panics.', opening: 'Steady trade in cheap staples, saving her strength for festivals.' } },
  { id: 'kasim', slug: 'kasim', art: 'kasim', name: 'Kasim', color: '#d35d47', model: 'claude-haiku-5-5',
    persona: 'A loud, fast-talking young hawker who wins customers by always being the cheapest stall. Thin margins, high volume, a little reckless, loves a bargain and a boast.',
    profile: { bio: 'Young, loud and fast. Wins customers by always being the cheapest stall in town.', opening: 'Undercuts everyone on everything: thin margins, big volume.' } },
  { id: 'vey', slug: 'vey', art: 'vey', name: 'Vey', color: '#8e6cc9', model: 'claude-sonnet-5-5',
    persona: 'An aristocratic silk merchant who sells quality to the rich at high margins and refuses to scrap over coppers. Disdains Kasim. Calls people "darling".',
    profile: { bio: 'Silk merchant to the nobility. Will not haggle in the dust over coppers.', opening: 'Premium silk: few sales, fat margins, loyal rich customers.' } },
  { id: 'ozzo', slug: 'ozzo', art: 'ozzo', name: 'Ozzo', color: '#3b8bd0', model: 'claude-opus-5-5',
    persona: 'A monk turned merchant who never forgets a rumor. Bold, greedy and scheming; tries to corner whatever market is about to spike. Thinks slowly and deeply, plans several moves ahead.',
    profile: { bio: 'A monk turned merchant who never forgets a rumor, and never forgives a debt.', opening: 'Waits for a rumor, then tries to corner the good that is about to spike.' } },
];

// ---------- AI budget: never let many games stampede the API ----------
let aiInflight = 0;
const withAiSlot = async (fn, fallback) => {
  if (!aiOn() || aiInflight >= AI_MAX_INFLIGHT) return fallback();
  aiInflight++;
  try { return await fn(); } finally { aiInflight--; }
};

// ---------- memory helpers ----------
function lesson(m, text) {
  m.lessons ||= [];
  if (m.lessons.at(-1) === text) return;
  m.lessons.push(text);
  if (m.lessons.length > 8) m.lessons.shift();
}
function mood(m) {
  const r = m.relation || 0;
  return r >= 2 ? { key: 'warm', label: 'friendly' } : r <= -2 ? { key: 'cold', label: 'hostile' } : r === -1 ? { key: 'wary', label: 'wary' } : { key: 'neutral', label: 'neutral' };
}

// ---------- games ----------
const games = new Map();
let liveHolder = null; // id of the game that holds the live testnet table

class Game {
  constructor(id, live, seed) {
    this.id = id; this.live = live; this.lastSeen = Date.now();
    this.running = false; this.speedMs = 2500; this.autoPause = true; this.decision = null; this.timer = null; this.thinking = new Set(); this.pnlBuffer = {};
    this.chain = makeChain(live);
    this.reset(seed);
  }
  ownerOf(m) {
    if (m.ownedBy) return this.world.merchants.find(x => x.id === m.ownedBy).wallet;
    return m.wallet;
  }
  reset(seed = Math.floor(Math.random() * 1e6)) {
    this.pause();
    this.world = createWorld({ seed, merchants: ROSTER.map(r => ({ ...r })) });
    openingNews(this.world);
    this.pnlBuffer = {};
    this.chain.setupMerchants(this.world.merchants, m => this.ownerOf(m)).catch(e => console.error(e));
    for (const m of this.npcs()) this.npcThink(m);
  }
  // independent rivals think for themselves; vassal stalls follow their owner's strategy
  npcs() { return this.world.merchants.filter(m => !m.player && trading(m) && !m.ownedBy); }
  me() { return this.world.merchants.find(m => m.player); }

  npcThink(m) {
    if (this.thinking.has(m.id) || !trading(m)) return;
    this.thinking.add(m.id);
    const w = this.world;
    withAiSlot(() => think(w, m), () => think(w, { ...m, _offline: true }))
      .then(d => {
        if (this.world !== w || !trading(m)) return;
        this.remember(m, d);
        m.doctrine = { stance: d.stance, focus: d.focus, aggression: d.aggression };
        if (d.bark) m.bark = d.bark;
        m.thought = d.thought; m.brain = d.engine; m.thinkMs = d.ms; m.cached = d.cached;
        if (d.claim) {
          const c = w.contracts.find(c => c.status === 'open' && !c.takenBy);
          if (c) { acceptContract(w, m, c.id); m.doctrine = { stance: 'corner', focus: c.good, aggression: Math.max(0.7, d.aggression) }; }
        }
      })
      .catch(e => { m.brain = 'error'; console.error(`think ${m.id}:`, e.message); })
      .finally(() => this.thinking.delete(m.id));
  }

  // ---------- rivals learn: each strategy they drop becomes a lesson, good or bad ----------
  remember(m, next) {
    const w = this.world, worth = netWorth(w, m), cur = m.doctrine, ep = m.episode;
    const same = ep && cur.stance === next.stance && cur.focus === next.focus;
    if (ep && !same) {
      const delta = Math.round(worth - ep.worth), days = w.day - ep.day;
      if (days >= 2 && Math.abs(delta) >= 40) {
        const what = `${cur.stance}${cur.focus ? ' on ' + cur.focus : ''}`;
        lesson(m, delta > 0 ? `Playing ${what} on days ${ep.day}–${w.day} earned ${delta}g.` : `Playing ${what} on days ${ep.day}–${w.day} lost ${-delta}g.`);
      }
    }
    if (!same) m.episode = { day: w.day, worth };
  }

  tick() {
    const w = this.world;
    if (w.over) { this.pause(); return; }
    const hadRumor = w.pending, openBefore = w.contracts.filter(c => c.status === 'open' && !c.takenBy).length;
    const bankruptBefore = new Set(w.merchants.filter(m => m.bankrupt).map(m => m.id));
    const { settlement } = step(w);
    for (const r of settlement) this.pnlBuffer[r.merchant] = (this.pnlBuffer[r.merchant] || 0) + r.pnl;
    for (const d of backroomDeals(w, m => m.relation || 0)) {
      this.chain.recordDeal(d.buyer, d.seller, d.good, d.qty, d.total, w.merchants);
      if (d.reason === 'spite') lesson(d.seller, `Sold my ${d.good} to ${d.buyer.name} on day ${w.day} so the player could not fill the Palace order.`);
    }

    // rivals re-think every 4 days (staggered), or at once on a rumor, an event or a new Palace order
    const openNow = w.contracts.filter(c => c.status === 'open' && !c.takenBy).length;
    const fresh = (!hadRumor && w.pending) || w.news[0]?.kind === 'event' || openNow > openBefore;
    this.npcs().forEach((m, i) => { if (fresh || (w.day + i) % 4 === 0) this.npcThink(m); });

    // vultures: a rich rival seizes a bankrupt charter if the player hasn't within 3 days
    for (const t of w.merchants.filter(m => m.bankrupt && !m.ownedBy)) {
      if (t.bankruptDay == null) for (const o of this.npcs()) lesson(o, `Saw ${t.name} go bankrupt on day ${w.day} while playing ${t.doctrine.stance}${t.doctrine.focus ? ' on ' + t.doctrine.focus : ''}.`);
      t.bankruptDay ??= w.day;
      if (w.day - t.bankruptDay >= 3) {
        const buyer = this.npcs().filter(m => m.gold > takeoverPrice(w, t) * 2).sort((a, b) => b.gold - a.gold)[0];
        if (buyer && buyer.gold >= takeoverPrice(w, t) + Math.max(80, takeoverPrice(w, t) * 0.6)) { const price = takeover(w, buyer, t); buyer.bark = `${t.name}'s stall is mine now.`; t.bark = `I trade for ${buyer.name} now.`; this.chain.recordCharterSale(buyer, t, price, 'bankruptcy seizure'); }
      }
    }
    if (w.day % SETTLE_EVERY === 0 || w.over) this.flush();
    if (w.over) { this.pause(); return; }

    // key moments pause the game and offer one-click decisions
    const me = this.me(), G = Object.fromEntries(GOODS.map(g => [g.id, g]));
    const newRumor = !hadRumor && w.pending;
    const newOrder = openNow > openBefore && w.contracts.find(c => c.status === 'open' && !c.takenBy);
    const fallen = w.merchants.find(m => m.bankrupt && !m.ownedBy && !bankruptBefore.has(m.id) && !m.player);
    let d = null;
    if (fallen) {
      d = { kind: 'bankrupt', title: `${fallen.name} is bankrupt!`, text: `Their charter can be seized for ${takeoverPrice(w, fallen)} coins (plus working capital to reopen it). If you don't, a rival will within three days.`, actions: [{ label: 'Seize the charter', act: 'takeover', target: fallen.id }, { label: 'Let it go', act: 'resume' }] };
    } else if (newOrder) {
      const g = G[newOrder.good];
      d = { kind: 'palace', title: 'The Palace wants goods', text: `${newOrder.qty} ${g.units} of ${g.name.toLowerCase()} by day ${newOrder.due}, paying ${newOrder.reward} coins (a ${Math.round(newOrder.reward * 0.15)}-coin advance when you claim it). Rivals will race you for it.`, actions: [{ label: 'Claim it', act: 'claim', id: newOrder.id }, { label: 'Leave it', act: 'resume' }] };
    } else if (newRumor) {
      const e = w.pending, short = Object.entries(e.supply || {}).find(([, v]) => v < 1), glut = Object.entries(e.supply || {}).find(([, v]) => v > 1);
      const actions = short ? [{ label: `Corner ${G[short[0]].name.toLowerCase()}`, act: 'doctrine', doctrine: { stance: 'corner', focus: short[0], aggression: 0.8 } }]
        : e.demand ? [{ label: 'Hoard stock for the feast', act: 'doctrine', doctrine: { stance: 'hoard', focus: null, aggression: 0.7 } }]
        : glut ? [{ label: `Sell ${G[glut[0]].name.toLowerCase()} now`, act: 'doctrine', doctrine: { stance: 'liquidate', focus: null, aggression: 0.5 } }]
        : [{ label: 'Keep a cash cushion', act: 'doctrine', doctrine: { stance: 'premium', focus: null, aggression: 0.4 } }];
      const hint = short ? `${G[short[0]].name} will be scarce tomorrow. Whoever holds it sets the price.` : e.demand ? 'A feast is coming: prices will rise across the board.' : glut ? `A flood of ${G[glut[0]].name.toLowerCase()} is coming: prices will crash.` : 'Rents are about to double. Thin margins will hurt.';
      const hire = e.demand && !me.helpers ? [{ label: `Hire 2 helpers for the feast (${2 * HELPER_WAGE} coins/day)`, act: 'hire', n: 2, days: 4 }] : [];
      d = { kind: 'rumor', title: 'A rumor in the bazaar', text: `“${e.rumor}” ${hint}${e.demand ? ' Crowds will be bigger than one stall can serve.' : ''}`, actions: [...actions, ...hire, { label: 'Ignore it', act: 'resume' }] };
    }
    const storm = w.lastStorm?.day === w.day;
    if (!d && storm && !me.awning) {
      const lost = w.lastStorm.losses[me.id] || 0;
      d = { kind: 'bankrupt', title: 'A sudden storm!', text: `Rain soaked your stock: about ${lost} coins of goods ruined. ${Object.entries(w.lastStorm.losses).filter(([id, v]) => id !== 'you' && v === 0).length ? 'Stalls with an awning lost nothing.' : ''} An awning costs ${AWNING_COST} coins, once.`, actions: [{ label: `Buy an awning (${AWNING_COST} coins)`, act: 'awning' }, { label: 'Take the risk', act: 'resume' }] };
    }
    if (d && this.autoPause && this.running) { this.decision = { ...d, day: w.day }; this.pause(); }
  }
  flush() {
    const w = this.world;
    this.chain.settle(w.day, Object.entries(this.pnlBuffer).map(([merchant, pnl]) => ({ merchant, pnl })), w.merchants, m => netWorth(w, m));
    this.pnlBuffer = {};
  }
  loop() {
    clearTimeout(this.timer);
    if (!this.running) return;
    if (Date.now() - this.lastSeen > IDLE_PAUSE_MS) { this.running = false; return; }
    this.tick();
    this.timer = setTimeout(() => this.loop(), this.speedMs);
  }
  play() { if (this.world.over) return; this.decision = null; this.running = true; this.loop(); }
  pause() { this.running = false; clearTimeout(this.timer); }

  view() {
    const w = this.world, me = this.me();
    return {
      day: w.day, seasonDays: SEASON_DAYS, running: this.running, decision: this.decision, autoPause: this.autoPause, speedMs: this.speedMs, ai: aiOn() ? 'live' : 'heuristic',
      table: this.live ? 'live' : 'practice', liveBusy: !this.live && testnetAvailable && !!liveHolder,
      chain: this.chain.info(),
      goods: GOODS.map(g => ({ ...g, price: w.prices[g.id], history: w.history[g.id].slice(-60) })),
      events: w.active.map(e => ({ text: e.text, left: e.left })),
      rumor: w.pending?.rumor || null,
      contracts: w.contracts.slice(0, 6).map(c => ({ ...c, takenByName: c.takenBy ? w.merchants.find(m => m.id === c.takenBy)?.name : null, deliveredByName: c.deliveredBy ? w.merchants.find(m => m.id === c.deliveredBy)?.name : null, progress: c.takenBy ? Math.min(c.qty, w.merchants.find(m => m.id === c.takenBy).inventory[c.good]) : null })),
      news: w.news.slice(0, 30),
      merchants: w.merchants.map(m => ({
        id: m.id, name: m.name, art: m.art, color: m.color, player: !!m.player, gold: Math.round(m.gold), netWorth: Math.round(netWorth(w, m)),
        inventory: m.inventory, lastPnl: Math.round(m.lastPnl), doctrine: m.doctrine, bark: m.bark, thought: m.thought, brain: m.brain,
        modelLabel: MODEL_LABEL[m.model] || null, thinkMs: m.thinkMs || 0, thinking: this.thinking.has(m.id),
        bankrupt: m.bankrupt, ownedBy: m.ownedBy || null, vassal: !!m.ownedBy, tribute: Math.round(m.tribute || 0), trading: trading(m), tokenId: m.tokenId, wallet: m.wallet, owner: m.wallet ? this.ownerOf(m) : null,
        walletUrl: this.chain.explorerAccount(m.wallet), charters: chartersOwned(w, m), contractsWon: m.contractsWon || 0,
        netHistory: m.netHistory.slice(-60), lastAsk: m.lastAsk || {},
        takeoverPrice: m.bankrupt && !m.ownedBy ? takeoverPrice(w, m) : null,
        helpers: m.helpers || 0, helperDays: m.helperDays || 0, awning: !!m.awning, capacity: capacity(m), servedToday: m.servedToday || 0,
        profile: m.profile || null, lessons: (m.lessons || []).slice(-5), mood: m.player ? null : mood(m),
        buyoutHint: !m.player && trading(m) && !m.ownedBy ? buyoutValue(w, m) : null,
      })),
      standings: standings(w), over: w.over, result: w.result,
      chainFeed: this.chain.feed.slice(0, 30),
      me: { gold: Math.round(me.gold) },
    };
  }
}

function sweep() {
  const now = Date.now();
  for (const [id, g] of games) if (now - g.lastSeen > GAME_TTL_MS) { g.pause(); games.delete(id); }
  if (liveHolder && (!games.has(liveHolder) || now - games.get(liveHolder).lastSeen > LIVE_LEASE_MS)) liveHolder = null;
}
setInterval(sweep, 30_000).unref();

function gameFor(req, res) {
  const sid = /(?:^|;\s*)bs=([a-f0-9]{24})/.exec(req.headers.cookie || '')?.[1];
  let g = sid && games.get(sid);
  if (!g) {
    sweep();
    if (games.size >= MAX_GAMES) {
      const oldest = [...games.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
      oldest.pause(); games.delete(oldest.id);
    }
    const id = randomBytes(12).toString('hex');
    const live = testnetAvailable && !liveHolder;
    if (live) liveHolder = id;
    g = new Game(id, live, Number(process.env.SEED) || undefined);
    games.set(id, g);
    res.setHeader('Set-Cookie', `bs=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
  }
  g.lastSeen = Date.now();
  if (g.id === liveHolder) g.lastSeen = Date.now();
  return g;
}

// ---------- offers ----------
const lastOffer = new Map();
async function makeOffer(g, b) {
  const w = g.world, me = g.me(), rival = w.merchants.find(m => m.id === b.target && !m.player);
  if (!rival || !trading(rival)) throw new Error('That merchant is not trading');
  if (rival.ownedBy === 'you') throw new Error(`${rival.name} already works for you`);
  if (Date.now() - (lastOffer.get(g.id) || 0) < 2500) throw new Error('Give them a moment to think');
  lastOffer.set(g.id, Date.now());
  let offer;
  if (b.kind === 'buyout') {
    offer = { kind: 'buyout', price: Math.round(Number(b.price)) };
    if (!(offer.price > 0)) throw new Error('Name a price');
    if (offer.price > me.gold) throw new Error(`You only have ${Math.round(me.gold)} coins`);
  } else {
    offer = { kind: 'goods', good: b.good, qty: Math.round(Number(b.qty)), price: Math.round(Number(b.price) * 100) / 100 };
    if (!GOODS.some(x => x.id === offer.good) || !(offer.qty > 0) || !(offer.price > 0)) throw new Error('Choose a good, quantity and price');
    if (rival.inventory[offer.good] < offer.qty) throw new Error(`${rival.name} only holds ${rival.inventory[offer.good]} ${offer.good}`);
    if (offer.qty * offer.price > me.gold) throw new Error(`That costs ${Math.round(offer.qty * offer.price)} coins; you have ${Math.round(me.gold)}`);
  }
  // a merchant keeps their word: meeting their last counter-offer closes the deal
  g.counters ||= {};
  const key = `${rival.id}:${offer.kind}:${offer.good || ''}`, prior = g.counters[key];
  // a bulk counter ("take 20 at 22") is honoured for at least that many; a normal one for at most that many
  const reply = prior && offer.price >= prior.price && (offer.kind === 'buyout' || (prior.bulk ? offer.qty >= prior.qty : offer.qty <= prior.qty))
    ? { accept: true, counter: null, bark: 'A deal is a deal. The bazaar remembers who keeps their word.', thought: 'Met my own counter.', engine: 'rule' }
    : await withAiSlot(() => answerOffer(w, rival, me, offer), () => answerOffer(w, { ...rival, _offline: true }, me, offer));
  if (!reply.accept && reply.counter) g.counters[key] = { price: reply.counter, qty: reply.counterQty || offer.qty || 0, bulk: (reply.counterQty || 0) > (offer.qty || 0) };
  // how you treat them shapes their attitude toward you
  const fair = offer.kind === 'buyout' ? buyoutValue(w, rival) : w.prices[offer.good] * offer.qty;
  const asked = offer.kind === 'buyout' ? offer.price : offer.price * offer.qty;
  if (reply.accept) rival.relation = Math.min(3, (rival.relation || 0) + 1);
  else if (asked < fair * 0.6) { rival.relation = Math.max(-3, (rival.relation || 0) - 1); if ((rival.relation || 0) <= -2) lesson(rival, `The player keeps insulting me with lowball offers (day ${w.day}).`); }
  if (reply.accept) delete g.counters[key];
  rival.bark = reply.bark; rival.thought = reply.thought;
  if (reply.accept) {
    if (offer.kind === 'buyout') {
      executeBuyout(w, me, rival, offer.price);
      g.chain.recordCharterSale(me, rival, offer.price, 'agreed buyout');
      checkSeason(w);
    } else {
      const total = executeDeal(w, me, rival, offer.good, offer.qty, offer.price);
      g.chain.recordDeal(me, rival, offer.good, offer.qty, total, w.merchants);
    }
  } else {
    log(w, `${rival.name} turned down your ${offer.kind === 'buyout' ? 'buyout' : 'offer'}${reply.counter ? ` (would take ${reply.counter}${offer.kind === 'buyout' ? ' coins' : ` coins each${reply.counterQty && reply.counterQty !== offer.qty ? ` for ${reply.counterQty}` : ''}`})` : ''}.`, 'deal');
  }
  return { ...g.view(), reply: { ...reply, offer, rival: rival.name } };
}

// ---------- http ----------
const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
const body = req => new Promise(r => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e4) req.destroy(); }); req.on('end', () => { try { r(d ? JSON.parse(d) : {}); } catch { r({}); } }); });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };
const lastOrder = new Map();

http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  try {
    if (p === '/healthz') return send(res, 200, { ok: true, games: games.size, live: !!liveHolder, aiInflight });
    if (p.startsWith('/api/')) {
      const g = gameFor(req, res);
      if (p === '/api/state') return send(res, 200, g.view());
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
      const b = await body(req);
      const w = g.world, me = g.me();
      switch (p) {
        case '/api/play': g.play(); return send(res, 200, g.view());
        case '/api/pause': g.pause(); return send(res, 200, g.view());
        case '/api/speed': g.speedMs = Math.max(400, Math.min(5000, Number(b.ms) || 2500)); return send(res, 200, g.view());
        case '/api/hire': hireHelpers(w, me, Number(b.n), Number(b.days) || 4); return send(res, 200, g.view());
        case '/api/awning': buyAwning(w, me); return send(res, 200, g.view());
        case '/api/autopause': g.autoPause = !!b.on; return send(res, 200, g.view());
        case '/api/decide': {
          const a = g.decision?.actions?.[Number(b.index)];
          if (!a) return send(res, 400, { error: 'Nothing to decide' });
          try {
            if (a.act === 'doctrine') me.doctrine = { ...a.doctrine };
            if (a.act === 'hire') hireHelpers(w, me, a.n, a.days);
            if (a.act === 'awning') buyAwning(w, me);
            if (a.act === 'claim') { acceptContract(w, me, a.id); me.doctrine = { stance: 'corner', focus: w.contracts.find(c => c.id === a.id).good, aggression: Math.max(0.7, me.doctrine.aggression) }; }
            if (a.act === 'takeover') { const t = w.merchants.find(m => m.id === a.target); const price = takeover(w, me, t); g.chain.recordCharterSale(me, t, price, 'bankruptcy seizure'); t.bark = 'A new master, a fresh start. I will not fail you.'; checkSeason(w); }
          } catch (e) { g.decision = null; return send(res, 400, { error: e.message }); }
          g.play();
          return send(res, 200, g.view());
        }
        case '/api/simulate': {
          const days = Math.min(15, Number(b.days) || 10);
          g.pause();
          for (let i = 0; i < days && !w.over; i++) { g.tick(); await new Promise(r => setTimeout(r, 150)); }
          return send(res, 200, g.view());
        }
        case '/api/reset': g.reset(); return send(res, 200, g.view());
        case '/api/doctrine': {
          if (!STANCES.includes(b.stance)) return send(res, 400, { error: 'bad stance' });
          me.doctrine = { stance: b.stance, focus: GOODS.some(x => x.id === b.focus) ? b.focus : null, aggression: Math.min(1, Math.max(0, Number(b.aggression ?? 0.5))) };
          return send(res, 200, g.view());
        }
        case '/api/order': {
          if (!b.order?.trim()) return send(res, 400, { error: 'order required' });
          if (Date.now() - (lastOrder.get(g.id) || 0) < 1500) return send(res, 429, { error: 'Your factor is still writing…' });
          lastOrder.set(g.id, Date.now());
          const d = await withAiSlot(() => interpretOrder(w, me, b.order.trim().slice(0, 300)), () => interpretOrder(w, { ...me, _offline: true }, b.order.trim().slice(0, 300)));
          me.doctrine = { stance: d.stance, focus: d.focus, aggression: d.aggression };
          me.bark = d.bark; me.thought = d.thought; me.thinkMs = d.ms;
          return send(res, 200, { ...g.view(), reply: d });
        }
        case '/api/contract': acceptContract(w, me, b.id); me.doctrine = { stance: 'corner', focus: w.contracts.find(c => c.id === b.id).good, aggression: Math.max(0.7, me.doctrine.aggression) }; return send(res, 200, g.view());
        case '/api/offer': return send(res, 200, await makeOffer(g, b));
        case '/api/takeover': {
          const t = w.merchants.find(m => m.id === b.target);
          if (!t || t.ownedBy || !t.bankrupt) return send(res, 400, { error: 'not available' });
          const price = takeover(w, me, t);
          g.chain.recordCharterSale(me, t, price, 'bankruptcy seizure');
          me.bark = `The ${t.name} charter is ours.`;
          t.bark = 'A new master, a fresh start. I will not fail you.';
          checkSeason(w);
          if (w.over) g.flush();
          return send(res, 200, g.view());
        }
      }
      return send(res, 404, { error: 'unknown action' });
    }
    const file = join(process.cwd(), 'public', p === '/' ? 'index.html' : p.replace(/\.\./g, ''));
    const data = await readFile(file).catch(() => null);
    if (!data) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': extname(file) === '.webp' ? 'public, max-age=86400' : 'no-cache' });
    res.end(data);
  } catch (e) {
    if (!/not trading|no longer open|already holds|need|only|Give them|Choose|Name a price|doesn't have|costs/i.test(e.message)) console.error(e);
    send(res, 400, { error: e.message });
  }
}).listen(PORT, () => {
  console.log(`Bazaar Sovereign → http://localhost:${PORT} | live table: ${testnetAvailable ? 'NEAR testnet' : 'off (practice only)'} | minds: ${aiOn() ? 'live AI' : 'heuristic'}`);
});
