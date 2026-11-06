// Bazaar Sovereign — deterministic market simulation.
// One "day" = wholesale auction -> retail clearing -> costs -> bankruptcies.

export const GOODS = [
  { id: 'saffron', name: 'Saffron', unit: 'pouch', units: 'pouches', icon: '🌼', base: 40, supply: 14, demand: 16, storage: 0.6, spoil: 0 },
  { id: 'silk', name: 'Silk', unit: 'bolt', units: 'bolts', icon: '🧵', base: 26, supply: 18, demand: 18, storage: 0.4, spoil: 0 },
  { id: 'tea', name: 'Tea', unit: 'sack', units: 'sacks', icon: '🍃', base: 12, supply: 30, demand: 30, storage: 0.2, spoil: 0.06 },
  { id: 'salt', name: 'Salt', unit: 'block', units: 'blocks', icon: '🧂', base: 6, supply: 40, demand: 38, storage: 0.05, spoil: 0 },
];
const G = Object.fromEntries(GOODS.map(g => [g.id, g]));

export const STANCES = ['steady', 'undercut', 'corner', 'hoard', 'premium', 'liquidate'];

export const EVENTS = [
  { id: 'drought', text: 'Drought in the saffron fields', rumor: 'Farmers whisper the rains are late…', days: 4, supply: { saffron: 0.25 } },
  { id: 'caravan', text: 'A great silk caravan arrives', rumor: 'Dust on the eastern road — a caravan?', days: 2, supply: { silk: 2.4 } },
  { id: 'festival', text: 'Festival of Lanterns — the town feasts', rumor: 'Lantern makers are working overtime…', days: 3, demand: { saffron: 1.8, silk: 1.6, tea: 1.5, salt: 1.2 } },
  { id: 'monsoon', text: 'Monsoon floods the tea terraces', rumor: 'Clouds gather over the tea hills…', days: 3, supply: { tea: 0.3 } },
  { id: 'salt_glut', text: 'Salt barges flood the docks', rumor: 'Barges spotted upriver, riding low…', days: 2, supply: { salt: 2.5 } },
  { id: 'storm', text: 'A sudden storm lashes the bazaar', sudden: true, days: 1, demand: { saffron: 0.6, silk: 0.6, tea: 0.6, salt: 0.6 }, soak: 0.12 },
  { id: 'taxman', text: 'The Vizier doubles stall rents', rumor: 'The Vizier’s clerks are counting stalls…', days: 3, rent: 2 },
];

// Small seeded RNG so a run is reproducible (handy for demo + judges).
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export const RENT = 18;
export const SEASON_DAYS = 24;
export const BASE_CAPACITY = 22;   // customers a stall can serve in a day
export const HELPER_CAPACITY = 14; // extra customers per hired helper
export const HELPER_WAGE = 22;     // coins per helper per day
export const AWNING_COST = 120;    // one-time: protects stock from sudden storms
export const BAZAAR_TAX = 0.08; // the Vizier takes a cut of every retail sale

export function createWorld({ seed = 7, merchants }) {
  return {
    seed, rand: rng(seed), day: 0,
    prices: Object.fromEntries(GOODS.map(g => [g.id, g.base])),
    history: Object.fromEntries(GOODS.map(g => [g.id, [g.base]])),
    active: [],        // running events {id,text,left,...}
    pending: null,     // rumored event for tomorrow
    news: [],          // [{day,text,kind}]
    merchants: merchants.map(m => ({
      gold: 300, inventory: Object.fromEntries(GOODS.map(g => [g.id, 0])), cost: Object.fromEntries(GOODS.map(g => [g.id, 0])),
      sales: {}, bankrupt: false, netHistory: [300], lastPnl: 0, goodwill: 0.2,
      doctrine: { stance: 'steady', focus: null, aggression: 0.5 }, bark: '', ...m,
    })),
    ledger: [],        // per-day settlement rows for the chain layer
    contracts: [],     // Palace orders: {id, good, qty, reward, due, takenBy, status}
    magnate: null,     // the rich outsider (see MAGNATE)
    plot: null,        // a rival's rat plot against a warehouse: {by, target, day}
    guildLog: [],      // loans and repayments for the chain layer to mirror
    over: false, result: null,
  };
}

export function openingNews(w) {
  log(w, 'The bazaar opens. Four rival houses set out their stalls, and the Palace is watching.', 'event');
}

export const TRIBUTE = 0.2; // a vassal stall sends this share of each day's profit to its owner
export const trading = m => !m.bankrupt; // vassal stalls keep trading under their owner
export const log = (w, text, kind = 'info', extra = null) => { w.news.unshift({ day: w.day, text, kind, ...extra }); w.news.length = Math.min(w.news.length, 60); };

// ---------- street cries: a stall that calls out well draws shoppers for a few days ----------
// score 0..1 is how charming the cry was; a cry about one good helps that good most.
export const CRY = { days: 3, max: 0.3 };
export function cryBoost(w, m, good) {
  const c = m.cry; if (!c) return 0;
  const age = w.day - c.day; if (age < 0 || age >= CRY.days) return 0;
  const fit = c.good ? (c.good === good ? 1 : 0.35) : 0.7;
  return CRY.max * c.score * fit * (1 - age / CRY.days);
}
export function setCry(w, m, text, score, good = null) {
  m.cry = { text: String(text).slice(0, 120), score: Math.min(1, Math.max(0, Number(score) || 0)), good: GOODS.some(g => g.id === good) ? good : null, day: w.day };
  return m.cry;
}

export function netWorth(w, m) {
  return m.gold + GOODS.reduce((t, g) => t + m.inventory[g.id] * w.prices[g.id] * 0.8, 0) - debtOf(w, m);
}

function modifiers(w) {
  const sup = {}, dem = {}; let rent = 1;
  for (const g of GOODS) { sup[g.id] = 1; dem[g.id] = 1; }
  for (const e of w.active) {
    for (const [k, v] of Object.entries(e.supply || {})) sup[k] *= v;
    for (const [k, v] of Object.entries(e.demand || {})) dem[k] *= v;
    if (e.rent) rent *= e.rent;
  }
  return { sup, dem, rent };
}

// Stock a merchant has promised to the Palace and must not sell at retail.
export function reserved(w, m, good) {
  return w.contracts.filter(c => c.status === 'open' && c.takenBy === m.id && c.good === good).reduce((t, c) => t + c.qty, 0);
}

function palace(w) {
  // deliveries: a reserved order is fulfilled the moment its taker holds enough stock;
  // an unreserved one goes to the first merchant (largest stock first) who can fill it.
  for (const c of w.contracts.filter(c => c.status === 'open')) {
    const candidates = c.takenBy ? w.merchants.filter(m => m.id === c.takenBy) : w.merchants.filter(trading).sort((a, b) => b.inventory[c.good] - a.inventory[c.good]);
    const m = candidates.find(m => trading(m) && m.inventory[c.good] >= c.qty);
    if (m) {
      m.inventory[c.good] -= c.qty; m.gold += c.reward - (c.takenBy === m.id ? c.advance || 0 : 0); m.contractsWon = (m.contractsWon || 0) + 1;
      c.status = 'delivered'; c.deliveredBy = m.id;
      log(w, `${m.name} delivered ${c.qty} ${G[c.good].name} to the Palace and was paid ${c.reward} coins!`, 'palace');
      if (!m.player) m.bark = 'The Palace pays in gold, and I deliver in full.';
    } else if (w.day > c.due && c.takenBy && trading(w.merchants.find(x => x.id === c.takenBy)) && w.merchants.find(x => x.id === c.takenBy).inventory[c.good] >= Math.ceil(c.qty / 2)) {
      // partial delivery: at least half the order earns a pro-rated reward (minus the advance)
      const t = w.merchants.find(x => x.id === c.takenBy), q = t.inventory[c.good], pay = Math.round((c.reward * q) / c.qty * 0.7);
      t.inventory[c.good] -= q; t.gold += pay - (c.advance || 0); t.contractsWon = (t.contractsWon || 0) + 1;
      c.status = 'delivered'; c.deliveredBy = t.id; c.partial = q;
      log(w, `${t.name} delivered ${q} of ${c.qty} ${G[c.good].name} late and short; the Palace paid ${pay} coins.`, 'palace');
    } else if (w.day > c.due) {
      c.status = 'failed';
      if (c.takenBy) {
        const t = w.merchants.find(x => x.id === c.takenBy), fine = Math.min(60, Math.round(c.reward * 0.06));
        t.gold -= (c.advance || 0) + fine;
        log(w, `${t.name} failed the Palace order: the ${c.advance || 0}-coin advance is clawed back and a ${fine}-coin fine is due.`, 'bankrupt');
      } else log(w, `The Palace order for ${G[c.good].name} went unfilled.`, 'info');
    }
  }
  // a new order roughly every 6 days (first on day 3), at most one open at a time
  if (!w.over && !w.contracts.some(c => c.status === 'open') && (w.day === 2 || (w.day > 3 && w.rand() < 0.2))) {
    const g = GOODS[Math.floor(w.rand() * GOODS.length)];
    // sized so a healthy house can actually fund it (about 450 gold of stock at wholesale)
    const qty = Math.max(6, Math.round(Math.min(g.supply * (1 + w.rand() * 0.6), 450 / (g.base * 0.65))));
    const c = { id: `PO-${w.day}`, good: g.id, qty, reward: Math.round(qty * g.base * (1.6 + w.rand() * 0.4)), due: w.day + 5, takenBy: null, status: 'open', posted: w.day };
    w.contracts.unshift(c);
    log(w, `The Palace wants ${qty} ${g.name} by day ${c.due}, paying ${c.reward} coins.`, 'palace');
  }
  w.contracts.length = Math.min(w.contracts.length, 12);
}

export function acceptContract(w, m, id) {
  const c = w.contracts.find(c => c.id === id);
  if (!c || c.status !== 'open') throw new Error('That order is no longer open');
  if (c.takenBy) throw new Error('Someone already holds that order');
  c.takenBy = m.id;
  c.advance = Math.round(c.reward * 0.15); // the Palace pays an advance so the taker can buy stock
  m.gold += c.advance;
  log(w, `${m.name} claimed the Palace order for ${c.qty} ${G[c.good].name} and received a ${c.advance}-coin advance.`, 'palace');
  return c;
}

// Turn a high-level doctrine into concrete orders for one good.
function orders(w, m, g, rivals) {
  const d = m.doctrine, a = d.aggression ?? 0.5, focus = d.focus === g.id;
  const stock = Math.max(0, m.inventory[g.id] - reserved(w, m, g.id)), unitCost = m.cost[g.id] || g.base * 0.6;
  const wholesale = g.base * 0.62;
  const rivalMin = Math.min(...rivals.filter(r => r.inventory[g.id] > 0).map(r => r.lastAsk?.[g.id] ?? Infinity));
  let buyQty = Math.round(g.supply * 0.25), maxBid = wholesale * 1.05, ask = Math.max(unitCost, wholesale) * 1.35, floor = unitCost * 1.02;

  switch (d.stance) {
    case 'undercut':
      // a price war: beat the cheapest rival by a real margin, down to barely above cost
      buyQty = Math.round(g.supply * 0.25);
      ask = Number.isFinite(rivalMin) ? Math.max(unitCost * 1.14, rivalMin * (0.93 - 0.05 * a)) : Math.max(unitCost, wholesale) * 1.2; // floor covers the 8% tax
      break;
    case 'corner':
      if (focus) {
        // outbid everyone for the whole supply, then price as a monopolist once rivals run dry
        buyQty = g.supply * 2;
        maxBid = Math.min(wholesale * (1.25 + a * 0.6), w.prices[g.id] * 0.95);
        ask = Number.isFinite(rivalMin) ? Math.max(floor * 1.1, rivalMin * 0.98) : Math.max(unitCost * 1.6, g.base * (1.6 + a * 0.6));
      } else { buyQty = Math.round(g.supply * 0.1); }
      break;
    case 'hoard':
      if (focus || !d.focus) {
        buyQty = Math.round(g.supply * (0.3 + a * 0.3)); maxBid = wholesale * 1.15;
        ask = Math.max(unitCost * 1.6, w.prices[g.id] * 1.12); // sell only into a rising market
      }
      break;
    case 'premium':
      buyQty = Math.round(g.supply * 0.15); maxBid = wholesale * 1.15; ask = Math.max(unitCost, g.base) * 1.7;
      break;
    case 'liquidate':
      buyQty = 0; ask = Math.max(g.base * 0.4, unitCost * 0.7);
      break;
    default: // steady
      ask = Math.max(unitCost, wholesale) * (1.25 + a * 0.3);
  }
  return { buyQty: Math.max(0, buyQty), maxBid: +maxBid.toFixed(2), ask: +Math.max(0.5, ask).toFixed(2), sellCap: stock };
}

export function step(w) {
  w.day += 1;
  const trades = [];
  // ---- events: rumor yesterday becomes real today; maybe new rumor ----
  if (w.pending) {
    w.active.push({ ...w.pending, left: w.pending.days });
    log(w, `${w.pending.text}!`, 'event');
    w.pending = null;
  }
  // scripted opening: the very first day brings a rumor of a shortage, so a new player
  // gets a meaningful decision in the first seconds; after that, rumors are random
  if (w.day === 1 && !w.pending) {
    const first = w.rand() < 0.5 ? 'drought' : 'monsoon';
    const e = EVENTS.find(x => x.id === first);
    w.pending = e;
    log(w, `Rumor: ${e.rumor}`, 'rumor');
  } else if (w.day > 3 && !w.active.length && !w.pending && w.rand() < 0.07) {
    // a sudden storm: no rumor, no warning; stalls without an awning lose soaked stock
    const e = EVENTS.find(x => x.id === 'storm');
    w.active.push({ ...e, left: e.days });
    w.lastStorm = { day: w.day, losses: {} };
    for (const m of w.merchants.filter(trading)) {
      if (m.awning) continue;
      let lost = 0;
      for (const g of GOODS) { const q = Math.floor((m.inventory[g.id] - reserved(w, m, g.id)) * e.soak); if (q > 0) { m.inventory[g.id] -= q; lost += q * w.prices[g.id]; } }
      w.lastStorm.losses[m.id] = Math.round(lost);
    }
    log(w, `${e.text}! Stalls without an awning lose soaked stock.`, 'event');
  } else if (w.rand() < 0.22 && !w.active.length) {
    const pool = EVENTS.filter(x => !x.sudden);
    const e = pool[Math.floor(w.rand() * pool.length)];
    w.pending = e;
    log(w, `Rumor: ${e.rumor}`, 'rumor');
  }
  magnateMorning(w);
  ratsMorning(w);
  for (const v of w.merchants.filter(m => m.ownedBy && trading(m))) { const o = w.merchants.find(x => x.id === v.ownedBy); if (o) v.doctrine = { ...o.doctrine }; }
  allyRaids(w);
  const { sup, dem, rent } = modifiers(w);
  const alive = w.merchants.filter(trading);
  for (const m of w.merchants) m.servedToday = 0;
  const pnl = Object.fromEntries(w.merchants.map(m => [m.id, 0]));
  const mg = magnateSelling(w) ? w.magnate : null;
  if (mg) { pnl.magnate = 0; mg.stall.gold = 0; mg.today = { sold: 0, houses: 0 }; }

  for (const g of GOODS) {
    const hisGood = mg && mg.goods.includes(g.id);
    if (hisGood) { mg.stall.inventory[g.id] = shelfOf(mg, g.id); mg.stall.lastAsk = { ...mg.stall.lastAsk, [g.id]: magnatePrice(w, g.id) }; }
    const book = alive.map(m => ({ m, ...orders(w, m, g, [...alive.filter(r => r !== m), ...(hisGood ? [mg.stall] : [])]) }));
    if (hisGood) book.push({ m: mg.stall, buyQty: 0, maxBid: 0, ask: magnatePrice(w, g.id), sellCap: shelfOf(mg, g.id) });
    // ---- wholesale: pay-as-bid, highest bidder first ----
    let supply = Math.round(g.supply * sup[g.id] * (0.85 + w.rand() * 0.3));
    if (hisGood && mg.stage === 'monopoly') supply = Math.round(supply * (1 - MAGNATE.monopolySupply)); // he buys up the caravans
    const reserve = g.base * 0.58; // suppliers won't sell below this
    for (const b of [...book].sort((x, y) => y.maxBid - x.maxBid)) {
      if (!supply || !b.buyQty || b.maxBid < reserve) continue;
      // budget is shared across all goods: keep two days of rent in the till
      const affordable = Math.floor((b.m.gold - RENT * 2) / b.maxBid);
      const q = Math.min(supply, b.buyQty, Math.max(0, affordable));
      if (!q) continue;
      supply -= q;
      const price = b.maxBid;
      const m = b.m, held = m.inventory[g.id];
      m.cost[g.id] = (m.cost[g.id] * held + price * q) / (held + q);
      m.inventory[g.id] += q; m.gold -= price * q; pnl[m.id] -= price * q;
      trades.push({ day: w.day, merchant: m.id, side: 'buy', good: g.id, qty: q, price });
    }
    // ---- retail: market-share model ----
    // Each stall wins a share of shoppers that falls smoothly as its price rises relative
    // to the market (elasticity E); premium stalls get a quality bonus. Total demand follows
    // a linear curve in the share-weighted price. Shoppers a stall can't serve spill over.
    const choke = g.base * 3.2, A = g.demand * dem[g.id], E = 3.5;
    const Q = p => Math.max(0, A * (1 - p / choke));
    let sold = 0, revenue = 0;
    const sell = (b, q) => {
      q = Math.floor(q);
      if (q <= 0) return 0;
      sold += q; revenue += q * b.ask; b.m.servedToday = (b.m.servedToday || 0) + q;
      if (b.m.id !== 'magnate') {
        if (b.ask > g.base * 1.6 && b.m.doctrine.stance !== 'premium') b.m.gouged = true;
        else if (b.ask <= w.prices[g.id] * 1.05) b.m.fair = true; // at or below the going price
      }
      const net = q * b.ask * (1 - BAZAAR_TAX);
      b.m.inventory[g.id] -= q; b.m.gold += net; pnl[b.m.id] += net;
      trades.push({ day: w.day, merchant: b.m.id, side: 'sell', good: g.id, qty: q, price: b.ask });
      return q;
    };
    const avail = b => Math.max(0, Math.min(b.m.inventory[g.id] - reserved(w, b.m, g.id), capacity(b.m) - (b.m.servedToday || 0)));
    for (const b of book) b.m.lastAsk = { ...(b.m.lastAsk || {}), [g.id]: b.ask };
    let sellers = book.filter(b => avail(b) > 0 && b.ask < choke);
    // goodwill: loyal shoppers stick with a stall that has treated them fairly (the Magnate has none)
    const weight = b => Math.pow(g.base / b.ask, E) * (b.m.doctrine.stance === 'premium' ? 1.45 : 1) * (b.m.id === 'magnate' ? magnateWeight(mg) : (1 + (b.m.goodwill || 0)) * (1 + cryBoost(w, b.m, g.id)));
    if (sellers.length) {
      const W0 = sellers.reduce((t, b) => t + weight(b), 0);
      const pAvg = sellers.reduce((t, b) => t + b.ask * weight(b), 0) / W0;
      let left = Q(pAvg) * (0.9 + w.rand() * 0.2);
      for (let pass = 0; pass < 3 && left >= 1 && sellers.length; pass++) {
        const W = sellers.reduce((t, b) => t + weight(b), 0);
        let served = 0;
        for (const b of sellers) served += sell(b, Math.min(avail(b), (left * weight(b)) / W + (pass ? 0 : w.rand())));
        left -= served;
        sellers = sellers.filter(b => avail(b) > 0);
        if (!served) break;
      }
    }
    if (hisGood) {
      const shelf = shelfOf(mg, g.id), his = shelf - mg.stall.inventory[g.id];
      mg.today.sold += his; mg.today.houses += sold - his; mg.today[g.id] = his; mg.today.lostValue = (mg.today.lostValue || 0) + (sold - his) * g.base;
      // holding most of the shoppers means it is working: he brings more caravans tomorrow
      if (his >= (sold - his) && his >= shelf * 0.6) mg.shelf[g.id] = Math.min(MAGNATE.shelfMax, (mg.shelf[g.id] || MAGNATE.shelf) + MAGNATE.shelfGrow);
    }
    // market price = volume-weighted ask, or drifts up when nobody sells (scarcity)
    const unmet = A > 0 && sold === 0;
    const px = sold ? revenue / sold : w.prices[g.id] * (unmet ? 1.12 : 1);
    w.prices[g.id] = +(w.prices[g.id] * 0.4 + px * 0.6).toFixed(2);
    w.history[g.id].push(w.prices[g.id]);
    if (w.history[g.id].length > 120) w.history[g.id].shift();
  }

  // goodwill: fair trade earns it, gouging and empty shelves lose it
  for (const m of alive) {
    const before = m.goodwill ?? 0.2;
    m.goodwill = +Math.min(0.8, Math.max(0, before + (m.gouged ? -0.06 : m.fair ? 0.02 : m.servedToday > 0 ? 0 : -0.03))).toFixed(3);
    m.gouged = false; m.fair = false;
  }

  // coins spent off the Magnate's carts (or on a night watch) count in the day's books
  for (const m of w.merchants) if (m.pnlAdj) { pnl[m.id] += m.pnlAdj; m.pnlAdj = 0; }

  // ---- the Palace: deliveries, deadlines, new orders ----
  const before = Object.fromEntries(w.merchants.map(m => [m.id, m.gold]));
  palace(w);
  for (const m of w.merchants) pnl[m.id] += m.gold - before[m.id];

  // ---- costs, spoilage, bankruptcy ----
  for (const m of alive) {
    let cost = RENT * rent + (m.helpers || 0) * HELPER_WAGE;
    for (const g of GOODS) {
      cost += m.inventory[g.id] * g.storage;
      // stock reserved for the Palace is sealed in the Palace storeroom and does not spoil
      const keep = Math.min(m.inventory[g.id], reserved(w, m, g.id));
      if (g.spoil && m.inventory[g.id] > keep) m.inventory[g.id] = keep + Math.floor((m.inventory[g.id] - keep) * (1 - g.spoil));
    }
    m.gold -= cost; pnl[m.id] -= cost;
    // a rival short on rent takes a bridge bond from the Guild before pawning stock (unless it hates debt)
    if (m.gold < 0 && !m.player && !debtShy(m) && canBorrow(w, m)) { try { borrow(w, m, 'to cover the rent'); } catch {} }
    // fire sale: dump stock to pawnbrokers at 45% of base before declaring bankruptcy
    for (const g of GOODS) {
      if (m.gold >= 0) break;
      const need = Math.ceil(-m.gold / (g.base * 0.45));
      const q = Math.min(need, m.inventory[g.id]);
      if (q) { m.inventory[g.id] -= q; m.gold += q * g.base * 0.45; pnl[m.id] += q * g.base * 0.45; log(w, `${m.name} pawned ${q} ${g.name} to cover debts.`, 'warn'); }
    }
    if (m.ownedBy && pnl[m.id] > 0 && m.gold > 0) {
      const o = w.merchants.find(x => x.id === m.ownedBy), t = +(pnl[m.id] * TRIBUTE).toFixed(2);
      m.gold -= t; pnl[m.id] -= t; o.gold += t; pnl[o.id] += t; o.tribute = (o.tribute || 0) + t;
    }
    m.lastPnl = +pnl[m.id].toFixed(2);
    m.gold = +m.gold.toFixed(2);
    if (m.gold < 0) {
      m.bankrupt = true; m.bankruptDay = w.day;
      m.bark = 'My stall… my ledger… ruined!';
      log(w, `${m.name} is BANKRUPT. Their merchant charter is up for takeover.`, 'bankrupt');
      if (m.bonds?.length) {
        // the Guild seizes whatever stock is left and writes off the rest
        for (const g of GOODS) m.inventory[g.id] = 0;
        m.bonds = [];
        log(w, `The Moneylenders' Guild seizes what is left in ${m.name}'s warehouse.`, 'guild');
      }
    } else if (!m.player && m.bonds?.length && m.gold > debtOf(w, m) + 250) {
      while (m.bonds.length && m.gold > bondOwed(w, m.bonds[0]) + 250) repay(w, m);
    }
  }
  magnateEvening(w);
  // stock bought off the Magnate's carts arrives overnight
  for (const m of w.merchants) {
    for (const d of m.incoming || []) {
      m.cost[d.good] = (m.cost[d.good] * m.inventory[d.good] + d.price * d.qty) / (m.inventory[d.good] + d.qty);
      m.inventory[d.good] += d.qty;
    }
    m.incoming = [];
  }
  for (const m of w.merchants) { m.netHistory.push(+netWorth(w, m).toFixed(2)); if (m.netHistory.length > 120) m.netHistory.shift(); }
  for (const m of w.merchants) if (m.helpers && --m.helperDays <= 0) { m.helpers = 0; m.helperDays = 0; }
  for (const e of w.active) e.left -= 1;
  for (const e of w.active.filter(e => e.left <= 0)) log(w, `${e.text} has ended.`, 'info');
  w.active = w.active.filter(e => e.left > 0);

  rivalPreparations(w);
  checkSeason(w);
  const settlement = w.merchants.map(m => ({ merchant: m.id, pnl: m.lastPnl })).filter(r => r.pnl !== 0);
  w.ledger.push({ day: w.day, settlement, trades: trades.length });
  return { trades, settlement };
}

// Takeover: buyer absorbs a bankrupt merchant's charter (NFT), stock and debts.
export function takeoverPrice(w, target) {
  const stockValue = GOODS.reduce((t, g) => t + target.inventory[g.id] * w.prices[g.id], 0);
  return +Math.max(25, stockValue * 0.5 - target.gold * 0.5).toFixed(2); // debts lower the price
}

export function takeover(w, buyer, target) {
  const price = takeoverPrice(w, target);
  if (!target.bankrupt || target.ownedBy) throw new Error('Only unclaimed bankrupt charters can be taken over');
  if (target.magnateHeld) throw new Error(`${MAGNATE.name} holds that charter now`);
  const capital = Math.round(Math.max(80, price * 0.6)); // the new owner reopens the stall with working capital
  if (buyer.gold < price + capital) throw new Error(`You need ${Math.round(price + capital)} coins (${price} for the charter, ${capital} to reopen the stall)`);
  buyer.gold -= price + capital;
  target.gold = capital; target.bankrupt = false; target.ownedBy = buyer.id; target.vassalSince = w.day;
  log(w, `${buyer.name} seized ${target.name}'s charter. The stall reopens as ${buyer.player ? 'your' : buyer.name + "'s"} vassal and pays ${Math.round(TRIBUTE * 100)}% of its profit.`, 'takeover');
  return price;
}

// ---------- season ----------
export const chartersOwned = (w, m) => 1 + w.merchants.filter(x => x.ownedBy === m.id).length;

export function standings(w) {
  return w.merchants
    .map(m => ({ id: m.id, name: m.name, netWorth: Math.round(netWorth(w, m) + w.merchants.filter(v => v.ownedBy === m.id).reduce((t, v) => t + Math.max(0, netWorth(w, v)), 0)), charters: chartersOwned(w, m), out: !trading(m) || !!m.ownedBy, vassalOf: m.ownedBy || null, contracts: m.contractsWon || 0 }))
    .sort((a, b) => (a.out - b.out) || b.netWorth - a.netWorth);
}

export function checkSeason(w) {
  if (w.over) return;
  const me = w.merchants.find(m => m.player);
  let reason = null;
  if (me && me.bankrupt) reason = 'bankrupt';
  else if (me && chartersOwned(w, me) >= 3) reason = 'sovereign';
  else if (w.day >= SEASON_DAYS) reason = w.magnate?.stage === 'monopoly' ? 'magnate' : 'season';
  if (!reason) return;
  const table = standings(w);
  const rank = table.findIndex(r => r.id === me?.id) + 1;
  w.over = true;
  w.result = { reason, rank, table, day: w.day, win: reason === 'sovereign' || (reason === 'season' && rank === 1), magnate: reason === 'magnate' ? { goods: w.magnate.goods, charters: w.magnate.charters.length } : null };
  log(w, reason === 'sovereign' ? `${me.name} now holds three charters and is crowned SOVEREIGN OF THE BAZAAR!` : reason === 'bankrupt' ? 'Your house has fallen. The season is over.'
    : reason === 'magnate' ? `The season ends with ${MAGNATE.name} holding a monopoly on ${nameList(w.magnate.goods)}. The bazaar belongs to the Golden Caravan Company.` : `The season ends. ${table[0].name} is the richest house in the bazaar.`, 'event');
}

// ---------- deals (negotiation) ----------
// Direct goods trade between two merchants at an agreed unit price.
export function executeDeal(w, buyer, seller, good, qty, price) {
  if (seller.inventory[good] - reserved(w, seller, good) < qty) throw new Error(`${seller.name} doesn't have ${qty} ${G[good].name} to spare`);
  const total = Math.round(qty * price);
  if (buyer.gold < total) throw new Error(`You need ${total} coins`);
  buyer.gold -= total; seller.gold += total;
  buyer.cost[good] = (buyer.cost[good] * buyer.inventory[good] + price * qty) / (buyer.inventory[good] + qty);
  buyer.inventory[good] += qty; seller.inventory[good] -= qty;
  log(w, `${buyer.name} bought ${qty} ${G[good].name} from ${seller.name} at ${price} coins each.`, 'deal', { from: seller.id, to: buyer.id, good });
  return total;
}

// Buyout of a solvent rival: the buyer pays the price and absorbs the stall (stock and till).
export function buyoutValue(w, target) {
  return Math.round(Math.max(60, netWorth(w, target)));
}
export function executeBuyout(w, buyer, target, price) {
  if (!trading(target)) throw new Error(`${target.name} is not trading`);
  if (buyer.gold < price) throw new Error(`You need ${price} coins`);
  if (target.ownedBy) throw new Error(`${target.name} already serves another house`);
  buyer.gold -= price;
  target.ownedBy = buyer.id; target.soldFor = price; target.vassalSince = w.day;
  log(w, `${target.name} sold their charter to ${buyer.name} for ${price} coins. The stall now trades as ${buyer.player ? 'your' : buyer.name + "'s"} vassal and pays ${Math.round(TRIBUTE * 100)}% of its profit.`, 'takeover');
}

// ---------- back-room deals between rivals ----------
// Rivals trade with each other: to fill Palace orders they claimed, or out of spite to
// keep goods away from a player they resent. Returns the deals so the caller can put
// them on-chain (seller's wallet signs the goods transfer, buyer's wallet pays).
export function backroomDeals(w, relationToPlayer) {
  const deals = [];
  const npc = w.merchants.filter(m => !m.player && trading(m) && !m.ownedBy);
  const spare = (m, g) => Math.max(0, m.inventory[g] - reserved(w, m, g));
  const deal = (buyer, seller, good, qty, price, reason, bark) => {
    const total = Math.round(qty * price);
    if (qty < 1 || buyer.gold - total < RENT * 3) return false;
    buyer.gold -= total; seller.gold += total;
    buyer.cost[good] = (buyer.cost[good] * buyer.inventory[good] + price * qty) / (buyer.inventory[good] + qty);
    buyer.inventory[good] += qty; seller.inventory[good] -= qty;
    seller.bark = bark;
    log(w, `${seller.name} sold ${qty} ${G[good].name} to ${buyer.name}${reason === 'spite' ? ' — to keep it out of your hands' : ' to help fill a Palace order'}.`, 'deal', { from: seller.id, to: buyer.id, good });
    deals.push({ buyer, seller, good, qty, total, reason });
    return true;
  };
  for (const c of w.contracts.filter(c => c.status === 'open' && c.takenBy)) {
    const taker = w.merchants.find(m => m.id === c.takenBy);
    // a rival short on its Palace order buys from the others as the deadline nears
    if (!taker.player && c.due - w.day <= 3) {
      const short = c.qty - taker.inventory[c.good];
      const seller = short > 0 && npc.filter(m => m !== taker && spare(m, c.good) > 0).sort((a, b) => spare(b, c.good) - spare(a, c.good))[0];
      if (seller) deal(taker, seller, c.good, Math.min(short, spare(seller, c.good)), +(w.prices[c.good] * 1.25).toFixed(2), 'palace', `Take it, ${taker.name}. The Palace pays us both.`);
    }
    // rivals who resent the player sell their stock elsewhere to sink the player's order
    if (taker.player) {
      c.spited ||= [];
      for (const y of npc.filter(m => (relationToPlayer(m) <= -2) && spare(m, c.good) >= 3 && !c.spited.includes(m.id))) {
        const buyer = npc.filter(m => m !== y).sort((a, b) => b.gold - a.gold)[0];
        if (buyer && deal(buyer, y, c.good, spare(y, c.good), w.prices[c.good], 'spite', `Better in ${buyer.name}'s hands than yours.`)) { c.spited.push(y.id); y.spite = (y.spite || 0) + 1; }
      }
    }
  }
  return deals;
}

// ---------- staff and stall upgrades ----------
export const capacity = m => BASE_CAPACITY + (m.helpers || 0) * HELPER_CAPACITY;

export function hireHelpers(w, m, n, days) {
  n = Math.max(0, Math.min(3, Math.round(n))); days = Math.max(1, Math.min(6, Math.round(days)));
  if (n === 0) { m.helpers = 0; m.helperDays = 0; return; }
  if (m.gold < n * HELPER_WAGE * 2) throw new Error(`You need at least ${n * HELPER_WAGE * 2} coins to take on ${n} helper${n > 1 ? 's' : ''}`);
  m.helpers = n; m.helperDays = days;
  log(w, `${m.name} hired ${n} helper${n > 1 ? 's' : ''} for ${days} days (${n * HELPER_WAGE} coins a day).`, 'info');
}

export function buyAwning(w, m) {
  if (m.awning) throw new Error('Your stall already has an awning');
  if (m.gold < AWNING_COST + RENT * 2) throw new Error(`An awning costs ${AWNING_COST} coins`);
  m.gold -= AWNING_COST; m.awning = true;
  log(w, `${m.name} put up a sturdy awning against the storms.`, 'info');
}

// how rivals prepare: cautious and premium houses staff up for feasts and cover their stalls
export function rivalPreparations(w) {
  const festival = w.pending?.demand || w.active.some(e => e.demand && !e.sudden);
  for (const m of w.merchants.filter(m => !m.player && trading(m) && !m.ownedBy)) {
    const t = (m.persona || '').toLowerCase(), careful = /patient|cautious|noble|aristocratic|plans/.test(t), reckless = /reckless/.test(t);
    if (festival && !m.helpers && !reckless && m.gold > 260) { try { hireHelpers(w, m, careful ? 2 : 1, 4); } catch {} }
    const soaked = w.lastStorm?.losses?.[m.id] > 0 && w.lastStorm.day === w.day;
    if (!m.awning && !reckless && m.gold > 300 && (soaked || (careful && w.day >= 6))) { try { buyAwning(w, m); } catch {} }
  }
}

// ---------- the Magnate: a rich outsider who sells below cost until it stops paying ----------
// He arrives on day 6 (a rumor the day before), picks the two goods with the fattest margins and
// sells them under the bazaar's own wholesale price. Losing money to shoppers is his plan; what
// wears down his patience is overhead, stock bought off his carts (capped, delivered overnight)
// and stock left unsold because houses with goodwill kept their customers. Unopposed he grows,
// seizes bankrupt charters and takes a MONOPOLY: then he buys up the supply, prices high and
// owns the bazaar at season's end unless the houses win their shoppers back.
export const MAGNATE = {
  name: 'Baltazar', title: 'Magnate Baltazar of the Golden Caravan Company',
  rumorDay: 5, arriveDay: 6,
  patience: 900,     // coins of losses he will swallow before leaving
  overhead: 25,      // his caravans and guards, per day
  importCost: 0.68,  // his landed cost, x base price
  dumpPrice: 0.55,   // his shelf price while dumping, x base price
  rushCost: 0.85,    // what it costs him to rush in a caravan to replace stock bought off his carts, x base
  monopolyPrice: 1.0, // his shelf price once he owns a market, x base
  monopolySupply: 0.65, // share of the wholesale supply of his goods he buys up during a monopoly
  breakShare: 0.6, breakDays: 4, // houses break a monopoly by winning back this share of shoppers for this many days
  shelf: 10,         // units of each of his goods he starts with on his shelf each day
  shelfGrow: 4,      // more caravans each day he holds most of the shoppers
  shelfMax: 30,
  charterShelf: 10,  // extra shelf per seized charter
  lostShopper: 0.08, // patience lost for each unit of his goods a house sells instead of him, x base
  monopolyAt: 0.3, // houses' share of his goods' shoppers below which (2 days running) he holds a monopoly
  reachMax: 3,       // how far his name, criers and crowds can multiply his pull on shoppers
  raidCap: 8,        // units any one house may buy off his carts per day
};
const magnateSelling = w => ['dumping', 'monopoly'].includes(w.magnate?.stage);
export const magnatePrice = (w, good) => +(G[good].base * (w.magnate?.stage === 'monopoly' ? MAGNATE.monopolyPrice : MAGNATE.dumpPrice)).toFixed(2);
const magnateWeight = mg => mg?.reach || 1;
const shelfOf = (mg, good) => (mg.shelf?.[good] || MAGNATE.shelf) + (mg.charters?.length || 0) * MAGNATE.charterShelf;
const nameList = goods => goods.map(g => G[g].name.toLowerCase()).join(' and ');

function magnateMorning(w) {
  if (w.day === MAGNATE.rumorDay && !w.magnate) {
    w.magnate = { stage: 'coming' };
    log(w, 'Rumor: a rich outsider’s caravans are camped outside the gates, loaded to the axles…', 'rumor');
    return;
  }
  const mg = w.magnate;
  if (mg?.stage === 'coming' && w.day >= MAGNATE.arriveDay) {
    const margin = g => (w.prices[g.id] - g.base * 0.62) * g.demand;
    const goods = [...GOODS].sort((a, b) => margin(b) - margin(a)).slice(0, 2).map(g => g.id);
    Object.assign(mg, {
      stage: 'dumping', goods, loss: 0, arrived: w.day, allies: [], declined: [], quiet: 0, back: 0, lastLoss: 0, hits: [], charters: [], shelf: {}, share: 0,
      fallenBefore: w.merchants.filter(m => m.bankrupt).length,
      stall: { id: 'magnate', name: MAGNATE.name, inventory: Object.fromEntries(GOODS.map(g => [g.id, 0])), cost: {}, gold: 0, helpers: 20, doctrine: { stance: 'steady', focus: null, aggression: 0.5 }, servedToday: 0, lastAsk: {} },
    });
    log(w, `${MAGNATE.title} opens a vast stall and sells ${nameList(goods)} below cost. He will stay only while it pays.`, 'magnate');
  }
}

function magnateEvening(w) {
  const mg = w.magnate;
  if (!magnateSelling(w) || !mg.today) return;
  const before = mg.loss;
  // shoppers buying his cheap goods is planned marketing spend; what wears his patience down is
  // overhead, stock bought off his carts (counted when it happens) and every shopper a house kept
  let drain = MAGNATE.overhead + (mg.today.lostValue || 0) * MAGNATE.lostShopper;
  if (mg.stage === 'monopoly') {
    const landed = mg.goods.reduce((t, g) => t + (mg.today[g] || 0) * G[g].base * MAGNATE.importCost, 0);
    drain -= mg.stall.gold - landed; // monopoly profits refill his patience
  }
  mg.loss = Math.max(0, mg.loss + drain);
  mg.lastLoss = Math.round(mg.loss - before);
  const houseShare = mg.today.houses / Math.max(1, mg.today.houses + mg.today.sold);
  mg.share = +(1 - houseShare).toFixed(2);
  // winning makes him louder; losing shoppers makes him look like what he is
  mg.reach = +Math.min(MAGNATE.reachMax, Math.max(1, (mg.reach || 1) + (mg.share >= 0.5 ? 0.3 : -0.2))).toFixed(2);
  seizeCharters(w);
  if (mg.loss >= MAGNATE.patience) return magnateLeaves(w, 'bled');
  if (mg.stage === 'dumping') {
    mg.quiet = houseShare < MAGNATE.monopolyAt ? mg.quiet + 1 : 0;
    if (mg.quiet >= 2 || mg.charters.length >= 2) {
      mg.stage = 'monopoly'; mg.back = 0;
      log(w, `${MAGNATE.name} now holds a MONOPOLY on ${nameList(mg.goods)}. He buys up the caravans and raises his prices. Win back the shoppers or he owns the bazaar at season's end.`, 'magnate');
    }
  } else {
    mg.back = houseShare >= MAGNATE.breakShare ? mg.back + 1 : 0;
    if (mg.back >= MAGNATE.breakDays) magnateLeaves(w, 'broken');
  }
}

// A house that goes bankrupt while he is in town: unless someone seizes its charter within a day, he does.
function seizeCharters(w) {
  const mg = w.magnate;
  for (const t of w.merchants.filter(m => m.bankrupt && !m.player && !m.ownedBy && !m.magnateHeld && m.bankruptDay != null && w.day - m.bankruptDay >= 1)) {
    t.magnateHeld = true;
    mg.charters.push(t.id);
    (w.magnateLog ||= []).push({ kind: 'seize', id: t.id, price: takeoverPrice(w, t) });
    log(w, `${MAGNATE.name} buys ${t.name}'s charter for a pittance. Its customers now crowd his stall.`, 'magnate');
  }
}

function magnateLeaves(w, why) {
  const mg = w.magnate;
  mg.stage = 'gone'; mg.left = w.day; mg.why = why;
  log(w, why === 'bled'
    ? `${MAGNATE.name} has lost ${Math.round(mg.loss)} coins of patience in this stubborn bazaar. He packs his caravans and leaves: it is not worth his gold.`
    : `The houses have won their customers back. ${MAGNATE.name}'s monopoly is broken; he packs his caravans and leaves.`, 'magnate');
  // fire sale: the charters he seized are up for grabs again
  for (const id of mg.charters) {
    const t = w.merchants.find(m => m.id === id);
    if (!t) continue;
    t.magnateHeld = false; t.bankruptDay = w.day;
    log(w, `${t.name}'s charter goes to a fire sale as ${MAGNATE.name} leaves.`, 'takeover');
  }
}

// Buy cheap stock off the Magnate's carts while he is dumping: capped per house per day, delivered overnight.
export function raidMagnate(w, m, good, qty) {
  const mg = w.magnate;
  if (mg?.stage !== 'dumping') throw new Error(`${MAGNATE.name} is not selling cheap right now`);
  if (!mg.goods.includes(good)) throw new Error(`${MAGNATE.name} does not sell ${G[good].name.toLowerCase()}`);
  if (!trading(m)) throw new Error('A bankrupt house cannot trade');
  if (m.raidDay !== w.day) { m.raidDay = w.day; m.raided = 0; }
  const price = +(G[good].base * MAGNATE.dumpPrice).toFixed(2);
  if (MAGNATE.raidCap - m.raided < 1) throw new Error(`His clerks sell each house at most ${MAGNATE.raidCap} a day`);
  qty = Math.min(Math.floor(qty), MAGNATE.raidCap - m.raided, Math.floor(m.gold / price)); // as many as you can afford
  if (qty < 1) throw new Error(`You need ${Math.ceil(price)} coins for even one ${G[good].unit}`);
  const total = +(qty * price).toFixed(2);
  m.gold = +(m.gold - total).toFixed(2); m.pnlAdj = (m.pnlAdj || 0) - total; m.raided += qty;
  (m.incoming ||= []).push({ good, qty, price });
  const hurt = Math.round(qty * G[good].base * (MAGNATE.rushCost - MAGNATE.dumpPrice));
  mg.loss += hurt;
  mg.hits.unshift({ day: w.day, by: m.id, name: m.name, good, qty, hurt }); mg.hits.length = Math.min(mg.hits.length, 8);
  return { qty, total, hurt, price };
}

// Rivals in a pact with the player raid his carts every day; a rival racing a Palace order for one of his goods does too.
function allyRaids(w) {
  const mg = w.magnate;
  if (mg?.stage !== 'dumping') return;
  const done = [];
  for (const m of w.merchants.filter(m => !m.player && trading(m) && !m.ownedBy)) {
    const order = w.contracts.find(c => c.status === 'open' && c.takenBy === m.id && mg.goods.includes(c.good));
    if (!mg.allies.includes(m.id) && !order) continue;
    const good = order?.good || [...mg.goods].sort((a, b) => G[b].base - G[a].base)[0];
    const price = G[good].base * MAGNATE.dumpPrice;
    let qty = Math.min(MAGNATE.raidCap, Math.floor((m.gold - RENT * 3) / price));
    if (qty < 3 && mg.allies.includes(m.id) && !debtShy(m) && canBorrow(w, m)) {
      try { borrow(w, m, `to raid ${MAGNATE.name}'s carts`); } catch {}
      qty = Math.min(MAGNATE.raidCap, Math.floor((m.gold - RENT * 3) / price));
    }
    if (qty < 1) continue;
    try { const r = raidMagnate(w, m, good, qty); done.push(`${m.name} ${r.qty} ${G[good].name.toLowerCase()}`); } catch {}
  }
  if (done.length) log(w, `Bought off ${MAGNATE.name}'s carts, at a loss to him: ${done.join(', ')}.`, 'magnate');
}

export function joinPact(w, rival) {
  const mg = w.magnate;
  if (mg?.stage !== 'dumping') throw new Error('There is no price war to fight right now');
  if (!mg.allies.includes(rival.id)) mg.allies.push(rival.id);
  log(w, `${rival.name} joins your pact against ${MAGNATE.name}: they will buy off his carts every day.`, 'magnate');
}

// ---------- the Moneylenders' Guild: fixed bonds with a fee and daily interest ----------
export const GUILD = { bond: 150, fee: 0.05, daily: 0.03, maxBonds: 2 };
export const bondOwed = (w, b) => Math.round(b.principal * (1 + GUILD.fee + GUILD.daily * Math.max(0, w.day - b.day)));
export function debtOf(w, m) { return (m.bonds || []).reduce((t, b) => t + bondOwed(w, b), 0); }
const debtShy = m => /hates debt/i.test(m.persona || '');
export function canBorrow(w, m) {
  if (!trading(m) || (m.bonds || []).length >= GUILD.maxBonds) return false;
  return !(m.bonds || []).length || netWorth(w, m) >= GUILD.bond; // a second bond needs collateral
}
export function borrow(w, m, why = '') {
  if (!trading(m)) throw new Error('The Guild does not lend to a bankrupt house');
  if ((m.bonds || []).length >= GUILD.maxBonds) throw new Error(`The Guild lends at most ${GUILD.maxBonds} bonds at a time`);
  if (!canBorrow(w, m)) throw new Error('The Guild wants more collateral before a second bond');
  (m.bonds ||= []).push({ principal: GUILD.bond, day: w.day });
  m.gold = +(m.gold + GUILD.bond).toFixed(2);
  log(w, `${m.name} took a ${GUILD.bond}-coin bond from the Moneylenders' Guild${why ? ' ' + why : ''}.`, 'guild');
  w.guildLog.push({ id: m.id, kind: 'borrow', amount: GUILD.bond });
}
export function repay(w, m) {
  const b = m.bonds?.[0];
  if (!b) throw new Error('Nothing is owed to the Guild');
  const owe = bondOwed(w, b);
  if (m.gold < owe) throw new Error(`You need ${owe} coins to repay the bond`);
  m.gold = +(m.gold - owe).toFixed(2); m.bonds.shift();
  log(w, `${m.name} repaid a Guild bond: ${owe} coins (${owe - b.principal} of it fees and interest).`, 'guild');
  w.guildLog.push({ id: m.id, kind: 'repay', amount: owe });
}

// ---------- rats: a hostile rival hires the rat-catcher against your warehouse ----------
// Telegraphed a day ahead by a rumor. Counter: a night watch for that night, or make peace with
// the rival (a fair deal lifts their attitude) before the rats are let loose.
export const WATCH_COST = 25;
const PERISHABLE = ['saffron', 'silk', 'tea']; // rats leave salt alone
function ratsMorning(w) {
  const p = w.plot, M = id => w.merchants.find(m => m.id === id);
  if (p && p.day <= w.day) {
    w.plot = null;
    const by = M(p.by), t = M(p.target);
    if (!by || !t || !trading(by) || !trading(t)) {
      // the plot dies with the plotter's stall
    } else if ((by.relation || 0) > -2) {
      log(w, `${by.name} thinks better of it and pays the rat-catcher to stay home.`, 'info');
    } else if (t.watchDay === w.day) {
      log(w, `${t.player ? 'Your' : t.name + "'s"} night watch caught ${by.name}'s rat-catcher at the warehouse door. Not a sack was lost.`, 'event');
      by.bark = 'Watchmen? Who hires watchmen for a few sacks?';
      w.lastRats = { day: w.day, by: by.id, target: t.id, foiled: true };
    } else {
      const spare = g => Math.max(0, t.inventory[g] - reserved(w, t, g));
      const g = [...PERISHABLE].sort((a, b) => spare(b) * w.prices[b] - spare(a) * w.prices[a])[0];
      const q = Math.floor(spare(g) * 0.25);
      if (q > 0) {
        t.inventory[g] -= q; t.goodwill = Math.max(0, (t.goodwill || 0) - 0.1); // word gets round
        log(w, `Rats in ${t.player ? 'your' : t.name + "'s"} warehouse! ${q} ${q === 1 ? G[g].unit : G[g].units} of ${G[g].name.toLowerCase()} ruined. ${by.name} hides a smile.`, 'bankrupt');
        by.bark = `Such a shame about your ${G[g].name.toLowerCase()}. Rats are everywhere these days.`;
        w.lastRats = { day: w.day, by: by.id, target: t.id, good: g, qty: q };
      } else log(w, `${by.name}'s rats found an empty warehouse and left hungry.`, 'info');
    }
  }
  // a rival who resents the player may plot (at most once every 6 days each)
  const me = w.merchants.find(m => m.player);
  if (!w.plot && me && trading(me) && w.day >= 4 && w.day <= SEASON_DAYS - 2) {
    const foes = w.merchants.filter(m => !m.player && trading(m) && !m.ownedBy && (m.relation || 0) <= -2 && !(m.lastPlot && w.day - m.lastPlot < 6));
    if (foes.length && w.rand() < 0.35) {
      const by = foes[Math.floor(w.rand() * foes.length)];
      w.plot = { by: by.id, target: me.id, day: w.day + 1 }; by.lastPlot = w.day;
      log(w, `Rumor: ${by.name} was seen haggling with the rat-catcher, glancing at your warehouse…`, 'rumor');
    }
  }
}
export function hireWatch(w, m) {
  if (!w.plot || w.plot.target !== m.id) throw new Error('Nobody is plotting against your warehouse');
  if (m.watchDay === w.plot.day) throw new Error('The watch is already hired for tonight');
  if (m.gold < WATCH_COST) throw new Error(`The night watch costs ${WATCH_COST} coins`);
  m.gold -= WATCH_COST; m.pnlAdj = (m.pnlAdj || 0) - WATCH_COST; m.watchDay = w.plot.day;
  log(w, `${m.name} hired a night watch for the warehouse (${WATCH_COST} coins).`, 'info');
}
