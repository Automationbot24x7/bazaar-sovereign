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

export const EVENTS = [
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
export const SEASON_DAYS = 30;
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
    contracts: [],     // Palace orders: {id, good, qty, reward, due, takenBy, status}
    over: false, result: null,
  };
}

export function openingNews(w) {
  log(w, 'The bazaar opens. Four rival houses set out their stalls, and the Palace is watching.', 'event');
}

export const TRIBUTE = 0.2; // a vassal stall sends this share of each day's profit to its owner
export const trading = m => !m.bankrupt; // vassal stalls keep trading under their owner
export const log = (w, text, kind = 'info') => { w.news.unshift({ day: w.day, text, kind }); w.news.length = Math.min(w.news.length, 60); };

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
      log(w, `${m.name} delivered ${c.qty} ${G[c.good].name} to the Palace and was paid ${c.reward} gold!`, 'palace');
      if (!m.player) m.bark = 'The Palace pays in gold, and I deliver in full.';
    } else if (w.day > c.due && c.takenBy && trading(w.merchants.find(x => x.id === c.takenBy)) && w.merchants.find(x => x.id === c.takenBy).inventory[c.good] >= Math.ceil(c.qty / 2)) {
      // partial delivery: at least half the order earns a pro-rated reward (minus the advance)
      const t = w.merchants.find(x => x.id === c.takenBy), q = t.inventory[c.good], pay = Math.round((c.reward * q) / c.qty * 0.7);
      t.inventory[c.good] -= q; t.gold += pay - (c.advance || 0); t.contractsWon = (t.contractsWon || 0) + 1;
      c.status = 'delivered'; c.deliveredBy = t.id; c.partial = q;
      log(w, `${t.name} delivered ${q} of ${c.qty} ${G[c.good].name} late and short; the Palace paid ${pay} gold.`, 'palace');
    } else if (w.day > c.due) {
      c.status = 'failed';
      if (c.takenBy) {
        const t = w.merchants.find(x => x.id === c.takenBy), fine = Math.min(60, Math.round(c.reward * 0.06));
        t.gold -= (c.advance || 0) + fine;
        log(w, `${t.name} failed the Palace order: the ${c.advance || 0}g advance is clawed back and a ${fine}g fine is due.`, 'bankrupt');
      } else log(w, `The Palace order for ${G[c.good].name} went unfilled.`, 'info');
    }
  }
  // a new order roughly every 6 days (first on day 3), at most one open at a time
  if (!w.over && !w.contracts.some(c => c.status === 'open') && (w.day === 3 || (w.day > 3 && w.rand() < 0.18))) {
    const g = GOODS[Math.floor(w.rand() * GOODS.length)];
    // sized so a healthy house can actually fund it (about 450 gold of stock at wholesale)
    const qty = Math.max(6, Math.round(Math.min(g.supply * (1 + w.rand() * 0.6), 450 / (g.base * 0.65))));
    const c = { id: `PO-${w.day}`, good: g.id, qty, reward: Math.round(qty * g.base * (1.6 + w.rand() * 0.4)), due: w.day + 5, takenBy: null, status: 'open', posted: w.day };
    w.contracts.unshift(c);
    log(w, `The Palace wants ${qty} ${g.name} by day ${c.due}, paying ${c.reward} gold.`, 'palace');
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
  log(w, `${m.name} claimed the Palace order for ${c.qty} ${G[c.good].name} and received a ${c.advance}g advance.`, 'palace');
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
  if (w.rand() < 0.22 && !w.active.length) {
    const e = EVENTS[Math.floor(w.rand() * EVENTS.length)];
    w.pending = e;
    log(w, `Rumor: ${e.rumor}`, 'rumor');
  }
  for (const v of w.merchants.filter(m => m.ownedBy && trading(m))) { const o = w.merchants.find(x => x.id === v.ownedBy); if (o) v.doctrine = { ...o.doctrine }; }
  const { sup, dem, rent } = modifiers(w);
  const alive = w.merchants.filter(trading);
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
      sold += q; revenue += q * b.ask;
      const net = q * b.ask * (1 - BAZAAR_TAX);
      b.m.inventory[g.id] -= q; b.m.gold += net; pnl[b.m.id] += net;
      trades.push({ day: w.day, merchant: b.m.id, side: 'sell', good: g.id, qty: q, price: b.ask });
      return q;
    };
    const avail = b => Math.max(0, b.m.inventory[g.id] - reserved(w, b.m, g.id));
    for (const b of book) b.m.lastAsk = { ...(b.m.lastAsk || {}), [g.id]: b.ask };
    let sellers = book.filter(b => avail(b) > 0 && b.ask < choke);
    const weight = b => Math.pow(g.base / b.ask, E) * (b.m.doctrine.stance === 'premium' ? 1.8 : 1);
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
    // market price = volume-weighted ask, or drifts up when nobody sells (scarcity)
    const unmet = A > 0 && sold === 0;
    const px = sold ? revenue / sold : w.prices[g.id] * (unmet ? 1.12 : 1);
    w.prices[g.id] = +(w.prices[g.id] * 0.4 + px * 0.6).toFixed(2);
    w.history[g.id].push(w.prices[g.id]);
    if (w.history[g.id].length > 120) w.history[g.id].shift();
  }

  // ---- the Palace: deliveries, deadlines, new orders ----
  const before = Object.fromEntries(w.merchants.map(m => [m.id, m.gold]));
  palace(w);
  for (const m of w.merchants) pnl[m.id] += m.gold - before[m.id];

  // ---- costs, spoilage, bankruptcy ----
  for (const m of alive) {
    let cost = RENT * rent;
    for (const g of GOODS) {
      cost += m.inventory[g.id] * g.storage;
      // stock reserved for the Palace is sealed in the Palace storeroom and does not spoil
      const keep = Math.min(m.inventory[g.id], reserved(w, m, g.id));
      if (g.spoil && m.inventory[g.id] > keep) m.inventory[g.id] = keep + Math.floor((m.inventory[g.id] - keep) * (1 - g.spoil));
    }
    m.gold -= cost; pnl[m.id] -= cost;
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
      m.bankrupt = true;
      m.bark = 'My stall… my ledger… ruined!';
      log(w, `${m.name} is BANKRUPT. Their merchant charter is up for takeover.`, 'bankrupt');
    }
  }
  for (const m of w.merchants) { m.netHistory.push(+netWorth(w, m).toFixed(2)); if (m.netHistory.length > 120) m.netHistory.shift(); }
  for (const e of w.active) e.left -= 1;
  for (const e of w.active.filter(e => e.left <= 0)) log(w, `${e.text} has ended.`, 'info');
  w.active = w.active.filter(e => e.left > 0);

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
  const capital = Math.round(Math.max(80, price * 0.6)); // the new owner reopens the stall with working capital
  if (buyer.gold < price + capital) throw new Error(`You need ${Math.round(price + capital)} gold (${price} for the charter, ${capital} to reopen the stall)`);
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
  else if (w.day >= SEASON_DAYS) reason = 'season';
  if (!reason) return;
  const table = standings(w);
  const rank = table.findIndex(r => r.id === me?.id) + 1;
  w.over = true;
  w.result = { reason, rank, table, day: w.day, win: reason === 'sovereign' || (reason === 'season' && rank === 1) };
  log(w, reason === 'sovereign' ? `${me.name} now holds three charters and is crowned SOVEREIGN OF THE BAZAAR!` : reason === 'bankrupt' ? 'Your house has fallen. The season is over.' : `The season ends. ${table[0].name} is the richest house in the bazaar.`, 'event');
}

// ---------- deals (negotiation) ----------
// Direct goods trade between two merchants at an agreed unit price.
export function executeDeal(w, buyer, seller, good, qty, price) {
  if (seller.inventory[good] - reserved(w, seller, good) < qty) throw new Error(`${seller.name} doesn't have ${qty} ${G[good].name} to spare`);
  const total = Math.round(qty * price);
  if (buyer.gold < total) throw new Error(`You need ${total} gold`);
  buyer.gold -= total; seller.gold += total;
  buyer.cost[good] = (buyer.cost[good] * buyer.inventory[good] + price * qty) / (buyer.inventory[good] + qty);
  buyer.inventory[good] += qty; seller.inventory[good] -= qty;
  log(w, `${buyer.name} bought ${qty} ${G[good].name} from ${seller.name} at ${price}g each.`, 'deal');
  return total;
}

// Buyout of a solvent rival: the buyer pays the price and absorbs the stall (stock and till).
export function buyoutValue(w, target) {
  return Math.round(Math.max(60, netWorth(w, target)));
}
export function executeBuyout(w, buyer, target, price) {
  if (!trading(target)) throw new Error(`${target.name} is not trading`);
  if (buyer.gold < price) throw new Error(`You need ${price} gold`);
  if (target.ownedBy) throw new Error(`${target.name} already serves another house`);
  buyer.gold -= price;
  target.ownedBy = buyer.id; target.soldFor = price; target.vassalSince = w.day;
  log(w, `${target.name} sold their charter to ${buyer.name} for ${price} gold. The stall now trades as ${buyer.player ? 'your' : buyer.name + "'s"} vassal and pays ${Math.round(TRIBUTE * 100)}% of its profit.`, 'takeover');
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
    log(w, `${seller.name} sold ${qty} ${G[good].name} to ${buyer.name}${reason === 'spite' ? ' — to keep it out of your hands' : ' to help fill a Palace order'}.`, 'deal');
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
