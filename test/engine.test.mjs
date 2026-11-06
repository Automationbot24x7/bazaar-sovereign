// Engine tests: run with `npm test` (no network, no API keys).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorld, step, netWorth, acceptContract, executeDeal, executeBuyout, takeover, takeoverPrice,
  backroomDeals, standings, chartersOwned, SEASON_DAYS, TRIBUTE,
  MAGNATE, GUILD, WATCH_COST, raidMagnate, joinPact, borrow, repay, debtOf, bondOwed, hireWatch,
} from '../server/engine.js';

const roster = () => [
  { id: 'you', name: 'You', player: true, persona: '' },
  { id: 'a', name: 'A', persona: '' },
  { id: 'b', name: 'B', persona: '' },
  { id: 'c', name: 'C', persona: '' },
];
const world = (seed = 1) => createWorld({ seed, merchants: roster() });
const M = (w, id) => w.merchants.find(m => m.id === id);

test('a season ends on day 30 with standings', () => {
  const w = world();
  for (let i = 0; i < 40 && !w.over; i++) step(w);
  assert.equal(w.over, true);
  assert.equal(w.day, SEASON_DAYS);
  assert.equal(w.result.reason, 'season');
  assert.equal(w.result.table.length, 4);
});

test('the same seed replays the same season (deterministic)', () => {
  const a = world(42), b = world(42);
  for (let i = 0; i < 15; i++) { step(a); step(b); }
  assert.deepEqual(a.prices, b.prices);
  assert.deepEqual(a.merchants.map(m => m.gold), b.merchants.map(m => m.gold));
});

test('a claimed Palace order reserves stock and pays on delivery', () => {
  const w = world();
  w.contracts.push({ id: 'PO-T', good: 'salt', qty: 10, reward: 500, due: 9, takenBy: null, status: 'open', posted: 0 });
  const me = M(w, 'you');
  const gold = me.gold;
  acceptContract(w, me, 'PO-T');
  assert.equal(me.gold, gold + 75, '15% advance paid on claim');
  me.inventory.salt = 10;
  step(w);
  const c = w.contracts.find(c => c.id === 'PO-T');
  assert.equal(c.status, 'delivered');
  assert.ok(me.gold > gold + 400, 'full reward received in total (minus a day of rent)');
});

test('goods deal moves stock and gold between houses', () => {
  const w = world(); const me = M(w, 'you'), a = M(w, 'a');
  a.inventory.silk = 8;
  executeDeal(w, me, a, 'silk', 5, 20);
  assert.equal(me.inventory.silk, 5); assert.equal(a.inventory.silk, 3);
  assert.equal(me.gold, 200); assert.equal(a.gold, 400);
  assert.throws(() => executeDeal(w, me, a, 'silk', 9, 1), /doesn't have/);
});

test('a bought-out rival becomes a vassal that pays tribute', () => {
  const w = world(); const me = M(w, 'you'), a = M(w, 'a');
  executeBuyout(w, me, a, 250);
  assert.equal(a.ownedBy, 'you');
  assert.equal(chartersOwned(w, me), 2);
  // make the vassal profitable for a day and check the owner receives a cut
  for (const g of ['saffron', 'silk', 'tea', 'salt']) { a.inventory[g] = 40; a.cost[g] = 1; }
  for (let i = 0; i < 3; i++) step(w);
  assert.ok((me.tribute || 0) > 0, 'tribute recorded');
  assert.equal(a.doctrine.stance, me.doctrine.stance, 'vassal follows owner strategy');
  const row = standings(w).find(r => r.id === 'you');
  assert.ok(row.netWorth >= Math.round(netWorth(w, me)), 'house worth includes vassals');
  assert.ok(TRIBUTE > 0 && TRIBUTE < 1);
});

test('three charters crown the player Sovereign', () => {
  const w = world(); const me = M(w, 'you');
  me.gold = 10000;
  executeBuyout(w, me, M(w, 'a'), 100);
  executeBuyout(w, me, M(w, 'b'), 100);
  step(w);
  assert.equal(w.over, true);
  assert.equal(w.result.reason, 'sovereign');
  assert.equal(w.result.win, true);
});

test('a bankrupt charter can be seized and reopens as a vassal', () => {
  const w = world(); const me = M(w, 'you'), b = M(w, 'b');
  b.bankrupt = true; b.gold = -20;
  me.gold = 1000;
  const price = takeoverPrice(w, b);
  takeover(w, me, b);
  assert.equal(b.bankrupt, false);
  assert.equal(b.ownedBy, 'you');
  assert.ok(b.gold >= 80, 'reopened with working capital');
  assert.ok(me.gold <= 1000 - price);
});

test('a resentful rival sells stock to another rival to sink the player\'s Palace order', () => {
  const w = world(); const me = M(w, 'you'), a = M(w, 'a'), b = M(w, 'b');
  w.contracts.push({ id: 'PO-S', good: 'tea', qty: 20, reward: 600, due: 6, takenBy: null, status: 'open', posted: 0 });
  acceptContract(w, me, 'PO-S');
  a.inventory.tea = 12; b.gold = 2000;
  const deals = backroomDeals(w, m => (m.id === 'a' ? -3 : 0));
  assert.equal(deals.length, 1);
  assert.equal(deals[0].reason, 'spite');
  assert.equal(deals[0].seller.id, 'a');
  assert.equal(a.inventory.tea, 0);
  assert.equal(backroomDeals(w, m => (m.id === 'a' ? -3 : 0)).length, 0, 'spites only once per order');
});

test('reserved Palace stock does not spoil; half an order earns a partial reward', () => {
  const w = world(); const me = M(w, 'you');
  w.contracts.push({ id: 'PO-P', good: 'tea', qty: 20, reward: 400, due: 2, takenBy: null, status: 'open', posted: 0 });
  acceptContract(w, me, 'PO-P');
  me.doctrine = { stance: 'liquidate', focus: null, aggression: 0.5 }; // buy nothing, so only spoilage could change stock
  me.inventory.tea = 12;
  step(w);
  assert.equal(me.inventory.tea, 12, 'sealed tea did not rot');
  step(w); step(w);
  const c = w.contracts.find(c => c.id === 'PO-P');
  assert.equal(c.status, 'delivered');
  assert.equal(c.partial, 12);
});

const until = (w, day) => { while (w.day < day && !w.over) step(w); };

test('the Magnate arrives on day 6, sells two goods below cost and leaves once he has lost his patience', () => {
  const w = world(5);
  until(w, MAGNATE.rumorDay);
  assert.equal(w.magnate.stage, 'coming');
  until(w, MAGNATE.arriveDay);
  const mg = w.magnate;
  assert.equal(mg.stage, 'dumping');
  assert.equal(mg.goods.length, 2);
  until(w, SEASON_DAYS);
  assert.ok(['gone', 'gouging'].includes(mg.stage), `stage ${mg.stage}`);
  if (mg.stage === 'gone' && mg.why === 'bled') assert.ok(mg.loss >= MAGNATE.patience);
});

test('buying off the Magnate\'s carts is capped, delivered overnight and costs him patience', () => {
  const w = world(6);
  until(w, MAGNATE.arriveDay);
  const me = M(w, 'you'), g = w.magnate.goods[0], held = me.inventory[g], loss = w.magnate.loss;
  me.gold = 1000;
  const r = raidMagnate(w, me, g, 50);
  assert.equal(r.qty, MAGNATE.raidCap, 'capped per day');
  assert.equal(me.inventory[g], held, 'not delivered until tonight');
  assert.ok(w.magnate.loss > loss, 'every unit bought is his loss');
  assert.throws(() => raidMagnate(w, me, g, 1), /at most/);
  const other = ['saffron', 'silk', 'tea', 'salt'].find(x => !w.magnate.goods.includes(x));
  assert.throws(() => raidMagnate(w, me, other, 1), /does not sell/);
  step(w);
  assert.ok(me.inventory[g] >= held + MAGNATE.raidCap - 1, 'delivered overnight');
});

test('pact allies raid his carts every day', () => {
  const w = world(7);
  until(w, MAGNATE.arriveDay);
  const a = M(w, 'a');
  a.gold = 600;
  joinPact(w, a);
  const loss = w.magnate.loss;
  step(w);
  assert.ok(w.magnate.hits.some(h => h.by === 'a'), 'ally bought off his carts');
  assert.ok(w.magnate.loss > loss);
});

test('Guild bonds charge a fee and daily interest, count against net worth, and are capped', () => {
  const w = world();
  const me = M(w, 'you'), worth = netWorth(w, me);
  borrow(w, me);
  assert.equal(me.gold, 300 + GUILD.bond);
  assert.equal(debtOf(w, me), Math.round(GUILD.bond * (1 + GUILD.fee)));
  assert.ok(netWorth(w, me) < worth, 'the fee costs net worth at once');
  borrow(w, me);
  assert.throws(() => borrow(w, me), /at most/);
  w.day += 4;
  const owe = bondOwed(w, me.bonds[0]);
  assert.equal(owe, Math.round(GUILD.bond * (1 + GUILD.fee + GUILD.daily * 4)));
  const gold = me.gold;
  repay(w, me);
  assert.equal(me.gold, gold - owe);
  assert.equal(me.bonds.length, 1);
  assert.equal(w.guildLog.map(x => x.kind).join(','), 'borrow,borrow,repay');
});

test('a hostile rival\'s rats are telegraphed; a night watch stops them, otherwise stock is lost', () => {
  for (const watch of [true, false]) {
    const w = world(11);
    const me = M(w, 'you'), foe = M(w, 'a');
    foe.relation = -3;
    me.inventory.saffron = 40;
    w.plot = { by: 'a', target: 'you', day: w.day + 1 };
    if (watch) { const gold = me.gold; hireWatch(w, me); assert.equal(me.gold, gold - WATCH_COST); }
    const before = me.inventory.saffron;
    step(w);
    if (watch) assert.match(w.news.map(n => n.text).join(' '), /night watch caught/);
    else assert.ok(me.inventory.saffron <= before - 10 + 2, `rats ate saffron (${before} -> ${me.inventory.saffron})`);
  }
});
