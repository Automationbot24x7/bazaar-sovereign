// Engine tests: run with `npm test` (no network, no API keys).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorld, step, netWorth, acceptContract, executeDeal, executeBuyout, takeover, takeoverPrice,
  backroomDeals, standings, chartersOwned, SEASON_DAYS, TRIBUTE,
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
  acceptContract(w, me, 'PO-T');
  me.inventory.salt = 10;
  const gold = me.gold;
  step(w);
  const c = w.contracts.find(c => c.id === 'PO-T');
  assert.equal(c.status, 'delivered');
  assert.ok(me.gold > gold + 400, 'reward paid (minus rent)');
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
  a.doctrine = { stance: 'steady', focus: null, aggression: 0.5 };
  a.inventory.saffron = 30; a.cost.saffron = 5;
  const before = me.gold;
  step(w);
  assert.ok((me.tribute || 0) > 0, 'tribute recorded');
  assert.ok(me.gold > before - 30, 'owner gold includes tribute');
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
