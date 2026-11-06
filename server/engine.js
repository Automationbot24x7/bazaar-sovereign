// Bazaar Sovereign — deterministic market simulation.
// One "day" = wholesale auction -> retail clearing -> costs -> bankruptcies.

export const GOODS = [
  { id: 'saffron', name: 'Saffron', icon: '🌼', base: 40, supply: 14, demand: 16, storage: 0.6, spoil: 0 },
  { id: 'silk', name: 'Silk', icon: '🧵', base: 26, supply: 18, demand: 18, storage: 0.4, spoil: 0 },
  { id: 'tea', name: 'Tea', icon: '🍃', base: 12, supply: 30, demand: 30, storage: 0.2, spoil: 0.06 },
  { id: 'salt', name: 'Salt', icon: '🧂', base: 6, supply: 40, demand: 38, storage: 0.05, spoil: 0 },
];
const G = Object.fromEntries(GOODS.map(g => [g.id, g]));

export const STANCES = ['steady', 'undercut', 'corner', 'hoard', 'premium', 'liquidate'];

const EVENTS = [
  { id: 'drought', text: 'Drought in the saffron fields', rumor: 'Farmers whisper the rains are late…', days: 4, supply: { saffron: 0.25 } },
  { id: 'caravan', text: 'A great silk caravan arrives', rumor: 'Dust on the eastern road — a caravan?', days: 2, supply: { silk: 2.4 } },
  { id: 'festival', text: 'Festival of Lanterns — the town feasts', rumor: 'Lantern makers are working overtime…', days: 3, demand: { saffron: 1.8, silk: 1.6, tea: 1.5, salt: 1.2 } },
  { id: 'monsoon', text: 'Monsoon floods the tea terraces', rumor: 'Clouds gather over the tea hills…', days: 3, supply: { tea: 0.3 } },
  { id: 'salt_glut', text: 'Salt barges flood the docks', rumor: 'Barges spotted upriver, riding low…', days: 2, supply: { salt: 2.5 } },
  { id: 'taxman', text: 'The Vizier doubles stall rents', rumor: 'The Vizier’s clerks are counting stalls…', days: 3, rent: 2 },
];

// Small seeded RNG so a run is reproducible (handy for demo + judges).
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export const RENT = 18;
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
      sales: {}, bankrupt: false, netHistory: [300], lastPnl: 0,
      doctrine: { stance: 'steady', focus: null, aggression: 0.5 }, bark: '', ...m,
    })),
    ledger: [],        // per-day settlement rows for the chain layer
  };
}

const log = (w, text, kind = 'info') => { w.news.unshift({ day: w.day, text, kind }); w.news.length = Math.min(w.news.length, 60); };

export function netWorth(w, m) {
  return m.gold + GOODS.reduce((t, g) => t + m.inventory[g.id] * w.prices[g.id] * 0.8, 0);
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

// Turn a high-level doctrine into concrete orders for one good.
function orders(w, m, g, rivals) {
  const d = m.doctrine, a = d.aggression ?? 0.5, focus = d.focus === g.id;
  const stock = m.inventory[g.id], unitCost = m.cost[g.id] || g.base * 0.6;
  const wholesale = g.base * 0.62;
  const rivalMin = Math.min(...rivals.filter(r => r.inventory[g.id] > 0).map(r => r.lastAsk?.[g.id] ?? Infinity));
  let buyQty = Math.round(g.supply * 0.25), maxBid = wholesale * 1.05, ask = Math.max(unitCost, wholesale) * 1.35, floor = unitCost * 1.02;

  switch (d.stance) {
    case 'undercut':
      buyQty = Math.round(g.supply * 0.3);
      ask = Number.isFinite(rivalMin) ? Math.max(floor, rivalMin - 0.5) : ask;
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
  if (w.rand() < 0.22 && !w.active.length) {
    const e = EVENTS[Math.floor(w.rand() * EVENTS.length)];
    w.pending = e;
    log(w, `Rumor: ${e.rumor}`, 'rumor');
  }
  const { sup, dem, rent } = modifiers(w);
  const alive = w.merchants.filter(m => !m.bankrupt);
  const pnl = Object.fromEntries(w.merchants.map(m => [m.id, 0]));

  for (const g of GOODS) {
    const book = alive.map(m => ({ m, ...orders(w, m, g, alive.filter(r => r !== m)) }));
    // ---- wholesale: pay-as-bid, highest bidder first ----
    let supply = Math.round(g.supply * sup[g.id] * (0.85 + w.rand() * 0.3));
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
    // ---- retail: linear demand curve, cheapest stall sells first ----
    const choke = g.base * 3.2, A = g.demand * dem[g.id];
    const Q = p => Math.max(0, Math.round(A * (1 - p / choke)));
    let served = 0, sold = 0, revenue = 0;
    const sell = (b, q) => {
      if (q <= 0) return;
      sold += q; revenue += q * b.ask;
      const net = q * b.ask * (1 - BAZAAR_TAX);
      b.m.inventory[g.id] -= q; b.m.gold += net; pnl[b.m.id] += net;
      trades.push({ day: w.day, merchant: b.m.id, side: 'sell', good: g.id, qty: q, price: b.ask });
    };
    const sellers = book.filter(b => b.m.inventory[g.id] > 0);
    for (const b of book) b.m.lastAsk = { ...(b.m.lastAsk || {}), [g.id]: b.ask };
    // loyal regulars: a slice of shoppers sticks to each stall if the price isn't absurd
    for (const b of sellers) {
      const loyal = Math.round(A * (b.m.doctrine.stance === 'premium' ? 0.14 : 0.07) * Math.max(0, 1 - b.ask / (choke * 0.9)) * 1.6);
      sell(b, Math.min(b.m.inventory[g.id], loyal));
    }
    // everyone else buys from the cheapest stall that still has stock
    for (const b of sellers.sort((x, y) => x.ask - y.ask)) {
      const room = Q(b.ask) - served;
      const q = Math.max(0, Math.min(b.m.inventory[g.id], room));
      served += q; sell(b, q);
    }
    // market price = volume-weighted ask, or drifts up when nobody sells (scarcity)
    const unmet = Q(0) > 0 && sold === 0;
    const px = sold ? revenue / sold : w.prices[g.id] * (unmet ? 1.12 : 1);
    w.prices[g.id] = +(w.prices[g.id] * 0.4 + px * 0.6).toFixed(2);
    w.history[g.id].push(w.prices[g.id]);
    if (w.history[g.id].length > 120) w.history[g.id].shift();
  }

  // ---- costs, spoilage, bankruptcy ----
  for (const m of alive) {
    let cost = RENT * rent;
    for (const g of GOODS) {
      cost += m.inventory[g.id] * g.storage;
      if (g.spoil && m.inventory[g.id]) m.inventory[g.id] = Math.floor(m.inventory[g.id] * (1 - g.spoil));
    }
    m.gold -= cost; pnl[m.id] -= cost;
    // fire sale: dump stock to pawnbrokers at 45% of base before declaring bankruptcy
    for (const g of GOODS) {
      if (m.gold >= 0) break;
      const need = Math.ceil(-m.gold / (g.base * 0.45));
      const q = Math.min(need, m.inventory[g.id]);
      if (q) { m.inventory[g.id] -= q; m.gold += q * g.base * 0.45; pnl[m.id] += q * g.base * 0.45; log(w, `${m.name} pawned ${q} ${g.name} to cover debts.`, 'warn'); }
    }
    m.lastPnl = +pnl[m.id].toFixed(2);
    m.gold = +m.gold.toFixed(2);
    if (m.gold < 0) {
      m.bankrupt = true;
      m.bark = 'My stall… my ledger… ruined!';
      log(w, `${m.name} is BANKRUPT. Their merchant charter is up for takeover.`, 'bankrupt');
    }
  }
  for (const m of w.merchants) { m.netHistory.push(+netWorth(w, m).toFixed(2)); if (m.netHistory.length > 120) m.netHistory.shift(); }
  for (const e of w.active) e.left -= 1;
  for (const e of w.active.filter(e => e.left <= 0)) log(w, `${e.text} has ended.`, 'info');
  w.active = w.active.filter(e => e.left > 0);

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
  if (!target.bankrupt) throw new Error('Only bankrupt charters can be taken over');
  if (buyer.gold < price) throw new Error(`Need ${price} gold`);
  buyer.gold -= price;
  for (const g of GOODS) {
    const q = target.inventory[g.id];
    if (q) { buyer.cost[g.id] = (buyer.cost[g.id] * buyer.inventory[g.id] + target.cost[g.id] * q) / (buyer.inventory[g.id] + q); buyer.inventory[g.id] += q; target.inventory[g.id] = 0; }
  }
  target.gold = 0;
  target.ownedBy = buyer.id;
  log(w, `${buyer.name} bought ${target.name}'s charter for ${price} gold and absorbed the stall.`, 'takeover');
  return price;
}
