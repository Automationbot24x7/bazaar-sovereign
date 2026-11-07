import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  GOODS, STANCES, SEASON_DAYS, createWorld, openingNews, step, netWorth, trading, takeover, takeoverPrice,
  acceptContract, executeDeal, executeBuyout, reserved, buyoutValue, standings, chartersOwned, log, checkSeason, backroomDeals, TRIBUTE,
  hireHelpers, buyAwning, capacity, HELPER_WAGE, AWNING_COST,
  CRY, setCry, MAGNATE, GUILD, WATCH_COST, magnatePrice, raidMagnate, joinPact, borrow, repay, debtOf, bondOwed, canBorrow, hireWatch,
} from './engine.js';
import { think, interpretOrder, answerOffer, answerPact, judgeCry, aiOn, stats, MODEL_LABEL, spend } from './brains.js';
import { makeChain, testnetAvailable } from './chain.js';
import { charterCard } from './card.js';

const PORT = process.env.PORT || 3000;
const SETTLE_EVERY = 5;
const MAX_GAMES = Number(process.env.MAX_GAMES || 150);
const IDLE_PAUSE_MS = 45_000;          // a game pauses when its tab stops polling
const GAME_TTL_MS = 30 * 60_000;       // and is forgotten after 30 idle minutes
const LIVE_LEASE_MS = Number(process.env.LIVE_LEASE_SEC || 180) * 1000; // a live testnet seat frees up after 3 idle minutes
const LIVE_TABLES = testnetAvailable ? Math.max(1, Number(process.env.LIVE_TABLES || 3)) : 0;
const AI_MAX_INFLIGHT = Number(process.env.AI_MAX_INFLIGHT || 10);

export const ROSTER = [
  { id: 'you', slug: 'player', art: 'player', name: 'Your House', player: true, color: '#e0a526', persona: 'The player.', model: 'claude-haiku-5-5' },
  { id: 'teodora', slug: 'teodora', art: 'teodora', name: 'Teodora', color: '#5aa469', voice: 0.45, model: 'claude-sonnet-5-5',
    persona: 'An elderly tea and salt trader with forty years at the same stall. Patient and cautious, hates debt, loves festivals, never panics. Calls younger merchants "children".',
    profile: { bio: 'Forty years at the same tea-and-salt stall. Patient, debt-shy, and never panics.', opening: 'Steady trade in cheap staples, saving her strength for festivals.' } },
  { id: 'kasim', slug: 'kasim', art: 'kasim', name: 'Kasim', color: '#d35d47', voice: 0.6, model: 'claude-haiku-5-5',
    persona: 'A loud, fast-talking young hawker who wins customers by always being the cheapest stall. Thin margins, high volume, a little reckless, loves a bargain and a boast.',
    profile: { bio: 'Young, loud and fast. Wins customers by always being the cheapest stall in town.', opening: 'Undercuts everyone on everything: thin margins, big volume.' } },
  { id: 'vey', slug: 'vey', art: 'vey', name: 'Vey', color: '#8e6cc9', voice: 0.4, model: 'claude-sonnet-5-5',
    persona: 'An aristocratic silk merchant who sells quality to the rich at high margins and refuses to scrap over coppers. Disdains Kasim. Calls people "darling".',
    profile: { bio: 'Silk merchant to the nobility. Will not haggle in the dust over coppers.', opening: 'Premium silk: few sales, fat margins, loyal rich customers.' } },
  { id: 'ozzo', slug: 'ozzo', art: 'ozzo', name: 'Ozzo', color: '#3b8bd0', voice: 0.3, model: 'claude-opus-5-5',
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
// lessons feed the rival's prompts (text) and show on its stall as short chips
function lesson(m, text, chip = null, tone = 'neutral') {
  m.lessons ||= []; m.chips ||= [];
  if (m.lessons.at(-1) === text) return;
  m.lessons.push(text);
  if (m.lessons.length > 8) m.lessons.shift();
  if (chip) { m.chips.push({ text: chip, tone }); if (m.chips.length > 3) m.chips.shift(); }
}
function mood(m) {
  const r = m.relation || 0;
  return r >= 2 ? { key: 'warm', label: 'friendly' } : r <= -2 ? { key: 'cold', label: 'hostile' } : r === -1 ? { key: 'wary', label: 'wary' } : { key: 'neutral', label: 'neutral' };
}

// ---------- games ----------
const games = new Map();
// live testnet tables: each is its own set of merchant wallets and charters, seated by one game at a time
const liveSeats = Array(LIVE_TABLES).fill(null); // table index -> game id
const freeSeat = () => liveSeats.indexOf(null);

class Game {
  constructor(id, table, seed) {
    this.id = id; this.lastSeen = Date.now();
    this.running = false; this.speedMs = 2500; this.autoPause = true; this.decision = null; this.decisionQueue = []; this.timer = null; this.thinking = new Set(); this.pnlBuffer = {};
    this.scenes = []; this.sceneSeq = 0; this.playerName = null;
    this.seat(table);
    this.reset(seed);
  }
  // sit at live table `table` (or the practice table when null); takes effect for the next season
  seat(table) {
    this.table = table; this.live = table !== null; this.seatLost = false;
    if (this.live) liveSeats[table] = this.id;
    this.chain = makeChain(this.live, table ?? 0);
  }
  leaveTable() {
    if (!this.live) return;
    liveSeats[this.table] = null;
    this.table = null; this.live = false; this.seatLost = true;
    this.chain.goPractice('Your seat at the live table was released after a few idle minutes. This game carries on as a practice table; start a new season to sit at a free live table.');
  }
  ownerOf(m) {
    if (m.magnateHeld) return this.chain.magnateWallet;
    if (m.ownedBy) return this.world.merchants.find(x => x.id === m.ownedBy).wallet;
    return m.wallet;
  }
  reset(seed = Math.floor(Math.random() * 1e6)) {
    this.pause();
    this.decision = null; this.decisionQueue = [];
    this.world = createWorld({ seed, merchants: ROSTER.map(r => ({ ...r, ...(r.player && this.playerName ? { name: this.playerName } : {}) })) });
    openingNews(this.world);
    this.pnlBuffer = {};
    this.scenes = [];
    this.scene('opening');
    this.chain.setupMerchants(this.world.merchants, m => this.ownerOf(m)).catch(e => console.error(e));
    for (const m of this.npcs()) this.npcThink(m);
  }
  // a rival with stock to spare, or short of cash, offers the player a bargain in its own voice
  incomingOffer() {
    const w = this.world, me = this.me(), G = Object.fromEntries(GOODS.map(g => [g.id, g]));
    const lines = {
      teodora: [g => `Fresh ${g}, child, and a fair price for a quick sale.`, g => `The Guild is knocking, child. Take some ${g} off my hands, cheaply.`],
      kasim: [g => `Psst! ${g}, cheaper than anywhere in town, today only!`, g => `Cash, friend, I need cash! ${g}, practically free!`],
      vey: [g => `Darling, I am clearing a little ${g}. You may have it.`, g => `A small favour, darling: buy some ${g}. Discreetly.`],
      ozzo: [g => `A quiet word: I have ${g} to spare, and the price is kind... today.`, g => `Coin is scarce even for the wise. ${g}, below the market.`],
    };
    const cands = w.merchants.filter(m => !m.player && trading(m) && !m.ownedBy && !m.magnateHeld && (m.relation || 0) > -2 && lines[m.id]).sort(() => Math.random() - 0.5);
    for (const m of cands) {
      // the stock worth the most (not simply the largest pile): an offer worth looking at
      const g = GOODS.map(x => x.id).filter(id => m.inventory[id] - reserved(w, m, id) >= 6).sort((a, b) => m.inventory[b] * w.prices[b] - m.inventory[a] * w.prices[a])[0];
      if (!g) continue;
      const spare = Math.floor(m.inventory[g] - reserved(w, m, g));
      if (spare < 6) continue;
      const needy = m.gold < 120 || (m.bonds?.length > 0);
      const price = +(w.prices[g] * (needy ? 0.78 : 0.88)).toFixed(1);
      const qty = Math.min(8, Math.floor(spare / 2), Math.floor((me.gold - 20) / price));
      if (qty < 2) continue;
      const total = Math.round(qty * price), name = G[g].name.toLowerCase();
      return { kind: 'offer', title: `${m.name} offers you a deal`,
        text: `“${lines[m.id][needy ? 1 : 0](name)}” ${qty} ${G[g].units} of ${name} at ${price} coins each (${total} in all; the market pays ${w.prices[g]}). ${this.live ? 'If you accept, both wallets sign intents and it settles on NEAR in one transaction.' : 'If you accept, both wallets sign intents (simulated on this practice table).'}`,
        actions: [{ label: `Accept · ${total} coins`, act: 'acceptoffer', from: m.id, good: g, qty, price }, { label: 'No thanks', act: 'resume' }] };
    }
    return null;
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
        // the line they shout is their street cry; how well it lands depends on their voice (Kasim is the loudest)
        if (d.bark) setCry(w, m, d.bark, (m.voice ?? 0.4) + (Math.random() - 0.5) * 0.2, d.focus);
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
        lesson(m, delta > 0 ? `Playing ${what} on days ${ep.day}–${w.day} earned ${delta} coins.` : `Playing ${what} on days ${ep.day}–${w.day} lost ${-delta} coins.`,
          delta > 0 ? `${what} paid +${delta}` : `Burned on ${what} −${-delta}`, delta > 0 ? 'good' : 'bad');
      }
    }
    if (!same) m.episode = { day: w.day, worth };
  }

  tick() {
    const w = this.world;
    if (w.over) { this.pause(); return; }
    const hadRumor = w.pending, openBefore = w.contracts.filter(c => c.status === 'open' && !c.takenBy).length;
    const bankruptBefore = new Set(w.merchants.filter(m => m.bankrupt).map(m => m.id));
    const magnateBefore = w.magnate?.stage, plotBefore = w.plot;
    const { settlement } = step(w);
    for (const r of settlement) this.pnlBuffer[r.merchant] = (this.pnlBuffer[r.merchant] || 0) + r.pnl;
    // story scenes at the big moments (the page plays them, skippable)
    const stage = w.magnate?.stage;
    if (stage !== magnateBefore) this.scene({ coming: 'rumor', dumping: 'arrival', monopoly: 'monopoly', gone: 'leaves' }[stage]);
    if ((w.magnateLog || []).some(e => e.kind === 'seize')) this.scene('seized', true);
    if (w.over) this.scene(w.result?.reason === 'magnate' ? 'wins' : 'end');
    this.mirrorGuild();
    const rats = w.lastRats?.day === w.day && w.lastRats;
    if (rats) {
      const by = w.merchants.find(m => m.id === rats.by), t = w.merchants.find(m => m.id === rats.target);
      if (rats.qty) {
        this.chain.recordLoss(t, rats.good, `Rats ruined ${rats.qty} ${rats.good} in ${t.player ? 'your' : t.name + "'s"} warehouse; the tokens are burned.`);
        lesson(by, `Set rats on the player's warehouse on day ${w.day}; they lost ${rats.qty} ${rats.good}.`, 'Sent rats to your warehouse', 'bad');
      } else lesson(by, `My rats were caught by the player's night watch on day ${w.day}.`, 'Rats caught by your watch', 'warn');
    }
    if (magnateBefore && magnateBefore !== 'coming' && magnateBefore !== w.magnate?.stage) {
      const mg = w.magnate;
      for (const m of this.npcs()) lesson(m, mg.stage === 'gone' ? `${MAGNATE.name} gave up and left the bazaar on day ${w.day}.` : `${MAGNATE.name} took a monopoly on ${mg.goods.join(' and ')} on day ${w.day}.`, mg.stage === 'gone' ? `Saw ${MAGNATE.name} leave` : `${MAGNATE.name} owns ${mg.goods.join('+')}`, 'warn');
    }
    if (w.lastStorm?.day === w.day) for (const m of this.npcs()) { const l = w.lastStorm.losses[m.id]; if (l > 0) lesson(m, `A sudden storm on day ${w.day} soaked ${l} coins of my stock; I had no awning.`, `Soaked by the storm −${l}`, 'bad'); }
    for (const d of backroomDeals(w, m => m.relation || 0)) {
      this.chain.recordDeal(d.buyer, d.seller, d.good, d.qty, d.total, w.merchants);
      if (d.reason === 'spite') lesson(d.seller, `Sold my ${d.good} to ${d.buyer.name} on day ${w.day} so the player could not fill the Palace order.`, 'Sank your Palace order', 'bad');
    }

    // rivals re-think every 4 days (staggered), or at once on a rumor, an event or a new Palace order
    const openNow = w.contracts.filter(c => c.status === 'open' && !c.takenBy).length;
    const fresh = (!hadRumor && w.pending) || w.news[0]?.kind === 'event' || openNow > openBefore;
    this.npcs().forEach((m, i) => { if (fresh || (w.day + i) % 4 === 0) this.npcThink(m); });

    // vultures: a rich rival seizes a bankrupt charter if the player hasn't within 3 days
    // charters the Magnate seized move to his wallet on-chain
    for (const e of (w.magnateLog || []).splice(0)) {
      const t = w.merchants.find(m => m.id === e.id);
      this.chain.recordCharterSale(this.chain.magnate, t, e.price, `seized by ${MAGNATE.name}`);
      for (const m of this.npcs()) lesson(m, `${MAGNATE.name} seized ${t.name}'s charter on day ${w.day}.`, `${MAGNATE.name} took ${t.name}`, 'warn');
    }
    for (const t of w.merchants.filter(m => m.bankrupt && !m.ownedBy && !m.magnateHeld)) {
      if (!t.fallSeen && (t.fallSeen = true)) for (const o of this.npcs()) lesson(o, `Saw ${t.name} go bankrupt on day ${w.day} while playing ${t.doctrine.stance}${t.doctrine.focus ? ' on ' + t.doctrine.focus : ''}.`, `Saw ${t.name} fall`, 'warn');
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
    // every key moment of the day is offered, the biggest first (the Magnate's moves), the rest queued behind it
    const found = [];
    let d = null;
    if (fallen) {
      d = { kind: 'bankrupt', title: `${fallen.name} is bankrupt!`, text: `Their charter can be seized for ${takeoverPrice(w, fallen)} coins (plus working capital to reopen it). ${['dumping', 'monopoly'].includes(w.magnate?.stage) ? `If you don't, ${MAGNATE.name} takes it tomorrow and grows stronger.` : "If you don't, a rival will within three days."}`, actions: [{ label: 'Seize the charter', act: 'takeover', target: fallen.id }, { label: 'Let it go', act: 'resume' }] };
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
    if (d) found.push(d);
    d = null;
    const mg = w.magnate;
    if (magnateBefore !== 'gone' && mg?.stage === 'gone') {
      const sale = mg.charters.map(id => w.merchants.find(m => m.id === id)).filter(t => t && t.bankrupt && !t.ownedBy);
      d = { kind: 'palace', title: `${MAGNATE.name} leaves the bazaar!`, text: `${mg.why === 'bled' ? 'He has lost too much patience in this stubborn bazaar.' : 'The houses won their customers back and broke his monopoly.'} ${sale.length ? `His charters go to a fire sale: ${sale.map(t => `${t.name} (${takeoverPrice(w, t)} coins)`).join(', ')}.` : ''}`,
        actions: [...sale.slice(0, 2).map(t => ({ label: `Seize ${t.name}'s charter`, act: 'takeover', target: t.id })), { label: 'Back to trading', act: 'resume' }] };
    } else if (magnateBefore === 'dumping' && mg?.stage === 'monopoly') {
      d = { kind: 'bankrupt', title: `${MAGNATE.name} holds a monopoly`, text: `He now controls ${mg.goods.map(x => G[x].name.toLowerCase()).join(' and ')}: he buys up most of the caravans' supply and sets the price. If he still holds it on day ${SEASON_DAYS}, he owns the bazaar and nobody wins. Break it by winning back ${Math.round(MAGNATE.breakShare * 100)}% of those shoppers for ${MAGNATE.breakDays} days: corner the supply, sell below him, keep your goodwill.`,
        actions: [{ label: `Corner ${G[mg.goods[0]].name.toLowerCase()}`, act: 'doctrine', doctrine: { stance: 'corner', focus: mg.goods[0], aggression: 0.85 } }, { label: 'Undercut on everything', act: 'doctrine', doctrine: { stance: 'undercut', focus: null, aggression: 0.7 } }, { label: 'Keep trading', act: 'resume' }] };
    } else if (magnateBefore === 'coming' && mg?.stage === 'dumping') {
      const best = [...mg.goods].sort((a, b) => w.prices[b] - w.prices[a])[0];
      const canBuy = Math.max(0, Math.min(MAGNATE.raidCap, Math.floor((me.gold - 5) / (G[best].base * MAGNATE.dumpPrice))));
      d = { kind: 'magnate', title: `${MAGNATE.name} opens his stall`, text: `${MAGNATE.title} sells ${mg.goods.map(x => `${G[x].name.toLowerCase()} at ${magnatePrice(w, x)}`).join(' and ')} coins, below his own cost, to steal every customer. He stays only while it pays. Make it not pay: buy off his carts (up to ${MAGNATE.raidCap} a day, delivered overnight), rally the rivals into a pact, or trade the goods he ignores.`,
        actions: [{ label: 'Rally the rivals', act: 'pacts' }, ...(canBuy > 0 ? [{ label: `Buy ${canBuy} cheap ${G[best].name.toLowerCase()} (${Math.ceil(canBuy * G[best].base * MAGNATE.dumpPrice)} coins)`, act: 'raid', good: best, qty: canBuy }] : []), { label: 'Ignore him for now', act: 'resume' }] };
    }
    if (d) found.unshift(d);   // the Magnate's moves come first
    d = null;
    if (w.plot && w.plot !== plotBefore && w.plot.target === me.id) {
      const foe = w.merchants.find(m => m.id === w.plot.by);
      d = { kind: 'bankrupt', title: 'Rats!', text: `${foe.name} resents you and was seen with the rat-catcher. Tomorrow night your warehouse could lose a quarter of its most valuable perishable stock. A night watch costs ${WATCH_COST} coins, or make ${foe.name} a fair offer to calm them down.`,
        actions: [{ label: `Hire the night watch (${WATCH_COST} coins)`, act: 'watch' }, { label: `Make ${foe.name} an offer`, act: 'deal', target: foe.id }, { label: 'Take the risk', act: 'resume' }] };
    }
    if (d) found.push(d);
    d = null;
    const storm = w.lastStorm?.day === w.day;
    if (storm && !me.awning) {
      const lost = w.lastStorm.losses[me.id] || 0;
      d = { kind: 'bankrupt', title: 'A sudden storm!', text: `Rain soaked your stock: about ${lost} coins of goods ruined. ${Object.entries(w.lastStorm.losses).filter(([id, v]) => id !== 'you' && v === 0).length ? 'Stalls with an awning lost nothing.' : ''} An awning costs ${AWNING_COST} coins, once.`, actions: [{ label: `Buy an awning (${AWNING_COST} coins)`, act: 'awning' }, { label: 'Take the risk', act: 'resume' }] };
    }
    if (d) found.push(d);
    // on a quiet day a rival may come to you with a deal of its own (agents trade, not only answer)
    if (!found.length && w.day >= 2 && w.day - (this.lastIncoming ?? -9) >= 3 && Math.random() < 0.45) {
      const o = this.incomingOffer();
      if (o) { found.push(o); this.lastIncoming = w.day; }
    }
    if (found.length && this.autoPause && this.running) {
      [this.decision, ...this.decisionQueue] = found.map(x => ({ ...x, day: w.day }));
      this.pause();
    }
  }
  scene(id, once = false) {
    if (!id || (once && this.scenes.some(s => s.id === id))) return;
    this.scenes.push({ id, seq: ++this.sceneSeq, day: this.world.day });
  }
  // loans and repayments become treasury <-> wallet transfers
  mirrorGuild() {
    const w = this.world;
    for (const e of w.guildLog.splice(0)) this.chain.recordGuild(w.merchants.find(m => m.id === e.id), e.kind, e.amount);
  }
  // ask rivals to join a pact against the Magnate (all of them, or one)
  async askPact(target, pay) {
    const w = this.world, me = this.me(), mg = w.magnate;
    if (mg?.stage !== 'dumping') throw new Error(`${MAGNATE.name} is not dumping goods right now`);
    mg.asks ||= {};
    const rivals = this.npcs().filter(m => (!target || m.id === target) && !mg.allies.includes(m.id));
    if (!rivals.length) throw new Error(target ? 'They are already in your pact' : 'Every rival is already in your pact');
    const replies = await Promise.all(rivals.map(async r => {
      const prior = mg.asks[r.id];
      if (pay && prior?.counter) {
        if (me.gold < prior.counter) throw new Error(`You need ${prior.counter} coins`);
        me.gold -= prior.counter; r.gold += prior.counter; me.pnlAdj = (me.pnlAdj || 0) - prior.counter; r.pnlAdj = (r.pnlAdj || 0) + prior.counter;
        this.chain.recordFee(me, r, prior.counter, `to join the pact against ${MAGNATE.name}`);
        return { r, a: { accept: true, counter: null, bark: 'Paid in full. My carts are yours.' } };
      }
      if (prior && !prior.accept && !prior.counter && prior.day === w.day) return { r, a: prior };
      return { r, a: await withAiSlot(() => answerPact(w, r, me), () => answerPact(w, { ...r, _offline: true }, me)) };
    }));
    for (const { r, a } of replies) {
      mg.asks[r.id] = { accept: a.accept, counter: a.accept ? null : a.counter, bark: a.bark, day: w.day };
      if (a.bark) r.bark = a.bark;
      if (a.accept) {
        joinPact(w, r);
        r.relation = Math.min(3, (r.relation || 0) + 1);
        lesson(r, `Joined the player's pact against ${MAGNATE.name} on day ${w.day}.`, `Allied vs ${MAGNATE.name}`, 'good');
      } else log(w, `${r.name} ${a.counter ? `will join your pact for ${a.counter} coins` : 'refuses your pact'}: “${a.bark}”`, 'magnate');
    }
    return replies.map(({ r, a }) => ({ id: r.id, name: r.name, accept: a.accept, counter: a.counter || null, bark: a.bark }));
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
  play() {
    if (this.world.over) return;
    // another key moment from the same day is still waiting: show it before the bazaar moves on
    const next = this.decisionQueue.shift();
    if (next && next.day === this.world.day) { this.decision = next; return; }
    this.decisionQueue = []; this.decision = null; this.running = true; this.loop();
  }
  pause() { this.running = false; clearTimeout(this.timer); }

  view() {
    const w = this.world, me = this.me();
    return {
      day: w.day, seasonDays: SEASON_DAYS, running: this.running, decision: this.decision, autoPause: this.autoPause, speedMs: this.speedMs, ai: aiOn() ? 'live' : 'heuristic',
      table: this.live ? 'live' : 'practice', liveTable: this.live ? this.table + 1 : null, liveTables: LIVE_TABLES, seatLost: this.seatLost,
      liveBusy: !this.live && LIVE_TABLES > 0 && freeSeat() < 0,
      chain: this.chain.info(),
      goods: GOODS.map(g => ({ ...g, price: w.prices[g.id], history: w.history[g.id].slice(-60) })),
      events: w.active.map(e => ({ id: e.id, text: e.text, left: e.left })),
      rumor: w.pending?.rumor || null,
      contracts: w.contracts.slice(0, 6).map(c => ({ ...c, takenByName: c.takenBy ? w.merchants.find(m => m.id === c.takenBy)?.name : null, deliveredByName: c.deliveredBy ? w.merchants.find(m => m.id === c.deliveredBy)?.name : null, progress: c.takenBy ? Math.min(c.qty, w.merchants.find(m => m.id === c.takenBy).inventory[c.good]) : null })),
      news: w.news.slice(0, 30),
      merchants: w.merchants.map(m => ({
        id: m.id, name: m.name, art: m.art, color: m.color, player: !!m.player, cry: m.cry && w.day - m.cry.day < CRY.days ? { ...m.cry, score: +m.cry.score.toFixed(2) } : null, gold: Math.round(m.gold), netWorth: Math.round(netWorth(w, m)),
        inventory: m.inventory, lastPnl: Math.round(m.lastPnl), doctrine: m.doctrine, bark: m.bark, thought: m.thought, brain: m.brain,
        modelLabel: MODEL_LABEL[m.model] || null, thinkMs: m.thinkMs || 0, thinking: this.thinking.has(m.id),
        bankrupt: m.bankrupt, magnateHeld: !!m.magnateHeld, goodwill: m.goodwill ?? 0, ownedBy: m.ownedBy || null, vassal: !!m.ownedBy, tribute: Math.round(m.tribute || 0), trading: trading(m), tokenId: m.tokenId, wallet: m.wallet, owner: m.wallet ? this.ownerOf(m) : null,
        walletUrl: this.chain.explorerAccount(m.wallet), charters: chartersOwned(w, m), contractsWon: m.contractsWon || 0,
        netHistory: m.netHistory.slice(-60), lastAsk: m.lastAsk || {},
        takeoverPrice: m.bankrupt && !m.ownedBy && !m.magnateHeld ? takeoverPrice(w, m) : null,
        helpers: m.helpers || 0, helperDays: m.helperDays || 0, awning: !!m.awning, capacity: capacity(m), servedToday: m.servedToday || 0,
        profile: m.profile || null, lessons: (m.lessons || []).slice(-5), chips: (m.chips || []).slice(-2), mood: m.player ? null : mood(m),
        buyoutHint: !m.player && trading(m) && !m.ownedBy ? buyoutValue(w, m) : null,
      })),
      standings: standings(w), over: w.over, result: w.result,
      chainFeed: this.chain.feed.slice(0, 30),
      scenes: this.scenes,
      me: { gold: Math.round(me.gold), debt: debtOf(w, me), bonds: (me.bonds || []).map(b => ({ day: b.day, owed: bondOwed(w, b) })), canBorrow: canBorrow(w, me), watch: w.plot?.target === me.id && me.watchDay === w.plot.day },
      guild: { bond: GUILD.bond, fee: GUILD.fee, daily: GUILD.daily, maxBonds: GUILD.maxBonds },
      plot: w.plot?.target === me.id ? { by: w.plot.by, byName: w.merchants.find(m => m.id === w.plot.by)?.name, day: w.plot.day, watchCost: WATCH_COST } : null,
      magnate: w.magnate ? {
        name: MAGNATE.name, title: MAGNATE.title, stage: w.magnate.stage, goods: w.magnate.goods || [], arriveDay: MAGNATE.arriveDay,
        prices: Object.fromEntries((w.magnate.goods || []).map(x => [x, magnatePrice(w, x)])),
        loss: Math.round(w.magnate.loss || 0), patience: MAGNATE.patience, share: w.magnate.share || 0, reach: w.magnate.reach || 1,
        charters: (w.magnate.charters || []).map(id => w.merchants.find(m => m.id === id)?.name), breakShare: MAGNATE.breakShare, breakDays: MAGNATE.breakDays, back: w.magnate.back || 0, monopolyAt: MAGNATE.monopolyAt, lastLoss: w.magnate.lastLoss || 0, left: w.magnate.left || null, why: w.magnate.why || null,
        raidCap: MAGNATE.raidCap, raidLeft: MAGNATE.raidCap - (me.raidDay === w.day ? me.raided || 0 : 0), incoming: (me.incoming || []).reduce((t, d) => t + d.qty, 0),
        allies: (w.magnate.allies || []), asks: w.magnate.asks || {}, hits: (w.magnate.hits || []).slice(0, 5),
      } : null,
    };
  }
}

function dropGame(g) {
  g.pause();
  if (g.live) liveSeats[g.table] = null;
  games.delete(g.id);
}

function sweep() {
  const now = Date.now();
  for (const [id, g] of games) if (now - g.lastSeen > GAME_TTL_MS) dropGame(g);
  for (const [i, id] of liveSeats.entries()) {
    const g = id && games.get(id);
    if (!id) continue;
    if (!g) liveSeats[i] = null;
    else if (now - g.lastSeen > LIVE_LEASE_MS) g.leaveTable();
  }
}
setInterval(sweep, 30_000).unref();

// ---------- per-visitor limits: every new game wakes four AI rivals, so bots must not mint games ----------
const clientIp = req => String(req.headers['fly-client-ip'] || req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const buckets = new Map();
function allow(req, kind, perHour) {
  const k = `${kind}:${clientIp(req)}`, now = Date.now(), b = buckets.get(k) || { n: 0, since: now };
  if (now - b.since > 3600_000) { b.n = 0; b.since = now; }
  b.n++; buckets.set(k, b);
  return b.n <= perHour;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.since > 3600_000) buckets.delete(k); }, 600_000).unref();
const LIMITS = { game: Number(process.env.LIMIT_GAMES_PER_HOUR || 15), ai: Number(process.env.LIMIT_AI_PER_HOUR || 80), season: Number(process.env.LIMIT_SEASONS_PER_HOUR || 20) };
const tooMany = what => Object.assign(new Error(`Too many ${what} from your connection; try again in a while`), { status: 429 });

function gameFor(req, res) {
  const fromHeader = /^[a-f0-9]{24}$/.test(req.headers['x-game'] || '') ? req.headers['x-game'] : null;
  const sid = fromHeader || /(?:^|;\s*)bs=([a-f0-9]{24})/.exec(req.headers.cookie || '')?.[1];
  let g = sid && games.get(sid);
  if (!g) {
    if (!allow(req, 'game', LIMITS.game)) throw tooMany('new games');
    sweep();
    if (games.size >= MAX_GAMES) {
      dropGame([...games.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0]);
    }
    const id = randomBytes(12).toString('hex');
    const seat = freeSeat();
    g = new Game(id, seat >= 0 ? seat : null, Number(process.env.SEED) || undefined);
    games.set(id, g);
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `bs=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure}`);
  }
  g.lastSeen = Date.now();
  res.setHeader('X-Game-Id', g.id);
  return g;
}

// ---------- the player's house name ----------
// Shown on the board and read by the rivals' minds, so it is kept short and plain: letters, spaces, ' & and -.
const TAKEN_NAMES = [...ROSTER.filter(r => !r.player).map(r => r.name), MAGNATE.name, 'Magnate', 'Vizier', 'Golden Caravan'];
function houseName(raw) {
  const n = String(raw ?? '').normalize('NFC').replace(/[^\p{L}\p{M} '&-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 24).trim();
  if (n.replace(/[^\p{L}]/gu, '').length < 2) throw new Error('Give your house a name of at least two letters');
  const words = ` ${n.toLowerCase().replace(/[^\p{L}]+/gu, ' ')} `; // whole words only: "Harvey" is fine, "Vey" is taken
  if (TAKEN_NAMES.some(x => words.includes(` ${x.toLowerCase()} `))) throw new Error('That name already belongs to someone in the bazaar');
  return n;
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
  else if (asked < fair * 0.6) { rival.relation = Math.max(-3, (rival.relation || 0) - 1); if ((rival.relation || 0) <= -2) lesson(rival, `The player keeps insulting me with lowball offers (day ${w.day}).`, 'Grudge: you lowballed me', 'bad'); }
  if (reply.accept && (rival.relation || 0) >= 2) lesson(rival, `The player deals fairly with me (day ${w.day}).`, 'Trusts you', 'good');
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
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.json': 'application/json', '.mp4': 'video/mp4' };
const lastOrder = new Map();

let keepsakes = 0;   // minted since the server started
const AI_ROUTES = new Set(['/api/offer', '/api/order', '/api/pact', '/api/cry']);
http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://huggingface.co https://*.hf.space"); // only the host page may embed the game
  try {
    if (AI_ROUTES.has(p) && req.method === 'POST' && !allow(req, 'ai', LIMITS.ai)) throw tooMany('requests to the rivals');
    if (p === '/api/reset' && req.method === 'POST' && !allow(req, 'season', LIMITS.season)) throw tooMany('new seasons');
    if (p === '/healthz') return send(res, 200, { ok: true, aiSpendToday: spend.usd, games: games.size, liveTables: LIVE_TABLES, liveSeated: liveSeats.filter(Boolean).length, aiInflight });
    // the charter NFT's living image, drawn from its on-chain state
    const card = /^\/charter\/(charter-[a-z0-9-]+)\.svg$/.exec(p);
    if (card) {
      const svg = await charterCard(card[1]);
      if (!svg) return send(res, 404, { error: 'no such charter' });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=30' });
      return res.end(svg);
    }
    if (p.startsWith('/api/')) {
      const g = gameFor(req, res);
      if (p === '/api/state') return send(res, 200, g.view());
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
      const b = await body(req);
      const w = g.world, me = g.me();
      switch (p) {
        case '/api/key': {
          // the player's browser registers the ed25519 key it made and keeps (never sent here)
          const pk = String(b.public_key || '');
          if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(pk)) throw new Error('Not an ed25519 public key');
          g.chain.registerPlayerKey(me, pk);
          return send(res, 200, g.view());
        }
        case '/api/keepsake': {
          // one keepsake per finished live season, and a small global cap (minting stores data on chain)
          if (!w.over) throw new Error('The season is not over yet');
          if (g.keepsake) throw new Error('This season already has its keepsake');
          if (keepsakes >= Number(process.env.KEEPSAKE_CAP || 15)) throw new Error('No keepsakes left today; come back tomorrow');
          if (!allow(req, 'keepsake', 3)) throw tooMany('keepsakes');
          const account = String(b.account || '').trim().toLowerCase();
          g.keepsake = 'pending';
          try {
            const token = await g.chain.mintKeepsake(me, account, netWorth(w, me), me.doctrine.stance, w.day);
            keepsakes++; g.keepsake = token || 'minted';
          } catch (e) { g.keepsake = null; throw e; }
          return send(res, 200, { ...g.view(), keepsake: { account, token: g.keepsake } });
        }
        case '/api/sign': { g.chain.completeSign(String(b.id || ''), b.signature); return send(res, 200, g.view()); }
        case '/api/cry': {
          // the player's crier shouts once a day; the crowd judges how well it lands
          const text = String(b.text ?? '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
          if (text.length < 4) throw new Error('Give your crier something to shout');
          if (me.cry && me.cry.day === w.day && me.cry.byPlayer) throw new Error('Your crier is hoarse. Shout again tomorrow');
          const j = await withAiSlot(() => judgeCry(w, me, text), () => judgeCry(w, { ...me, _offline: true }, text));
          setCry(w, me, text, j.charm / 10, j.good); me.cry.byPlayer = true; me.bark = text;
          log(w, `${me.name} cries: "${text}" — ${j.crowd} (charm ${j.charm}/10)`, 'cry');
          return send(res, 200, { ...g.view(), cryVerdict: j });
        }
        case '/api/name': { g.playerName = houseName(b.name); me.name = g.playerName; return send(res, 200, g.view()); }
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
            if (a.act === 'watch') hireWatch(w, me);
            if (a.act === 'raid') raidMagnate(w, me, a.good, a.qty || MAGNATE.raidCap);
            if (a.act === 'pacts') { const replies = await g.askPact(null, false); g.play(); return send(res, 200, { ...g.view(), pactReplies: replies }); }
            if (a.act === 'deal') { g.decision = null; return send(res, 200, { ...g.view(), openDeal: a.target }); }
            if (a.act === 'acceptoffer') {
              const seller = w.merchants.find(m => m.id === a.from);
              if (!seller || !trading(seller)) throw new Error('They are no longer trading');
              const total = executeDeal(w, me, seller, a.good, a.qty, a.price);
              seller.relation = Math.min(3, (seller.relation || 0) + 1);
              seller.bark = 'A pleasure doing business.';
              g.chain.recordDeal(me, seller, a.good, a.qty, total, w.merchants);
            }
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
        case '/api/reset': {
          // a practice player moves up to a live table when one is free
          if (!g.live && freeSeat() >= 0) g.seat(freeSeat());
          g.reset();
          return send(res, 200, g.view());
        }
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
        case '/api/raid': { raidMagnate(w, me, b.good, Number(b.qty) || MAGNATE.raidCap); return send(res, 200, g.view()); }
        case '/api/pact': { const replies = await g.askPact(b.target || null, !!b.pay); return send(res, 200, { ...g.view(), pactReplies: replies }); }
        case '/api/borrow': { borrow(w, me); g.mirrorGuild(); return send(res, 200, g.view()); }
        case '/api/repay': { repay(w, me); g.mirrorGuild(); return send(res, 200, g.view()); }
        case '/api/watch': { hireWatch(w, me); return send(res, 200, g.view()); }
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
    const type = MIME[extname(file)] || 'application/octet-stream', cache = ['.webp', '.mp3', '.mp4'].includes(extname(file)) ? 'public, max-age=86400' : 'no-cache';
    // video needs byte ranges (Safari will not play an mp4 without them)
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && extname(file) === '.mp4') {
      const size = data.length, start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2] || 0));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
      res.writeHead(206, { 'Content-Type': type, 'Cache-Control': cache, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
      return res.end(data.subarray(start, end + 1));
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache, ...(extname(file) === '.mp4' ? { 'Accept-Ranges': 'bytes' } : {}) });
    res.end(data);
  } catch (e) {
    if (!/not trading|no longer open|already holds|need|only|Give them|Choose|Name a price|doesn't have|costs|clerks|not selling|does not sell|not dumping|Guild|Nothing is owed|watch|plotting|pact|bankrupt house/i.test(e.message)) console.error(e);
    send(res, e.status || 400, { error: e.message });
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Bazaar Sovereign → http://localhost:${PORT} | live tables: ${LIVE_TABLES ? `${LIVE_TABLES} on NEAR testnet` : 'off (practice only)'} | minds: ${aiOn() ? 'live AI' : 'heuristic'}`);
});
