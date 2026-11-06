// NEAR layer.
//
// makeChain(live):
//  - live = true  → real NEAR testnet at one of the live tables (each table is its own set of
//                   merchant wallets and charters, so one game at a time can sit at it)
//  - live = false → practice table: identical flow, simulated hashes, no network.
//
// What happens on-chain at the live table:
//  * every merchant charter is a NEP-171 NFT owned by the merchant's own wallet
//    (<slug>.<root>.testnet), which holds the house's working capital in NEAR;
//  * goods are NEP-245 tokens in those wallets, mirrored from the market by the Vizier;
//  * profits/losses settle every 5 days as NEAR transfers treasury <-> merchant wallet;
//  * deals between houses go through escrow: the seller's wallet locks the goods for the buyer
//    (offer_goods), the buyer's wallet pays and receives them in one transaction (accept_goods);
//  * charter sales: the Vizier lists, the buyer's wallet calls buy_charter with the price attached.
import { Account, JsonRpcProvider, FailoverRpcProvider, KeyPair, actions, nearToYocto, yoctoToNear } from 'near-api-js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const RPCS = (process.env.NEAR_RPC || 'https://test.rpc.fastnear.com,https://rpc.testnet.near.org').split(',');
const ROOT = process.env.NEAR_ACCOUNT_ID; // the Vizier: game oracle and contract owner
function loadKey() {
  if (process.env.NEAR_PRIVATE_KEY) return process.env.NEAR_PRIVATE_KEY;
  if (!ROOT) return null;
  for (const dir of [process.env.NEAR_KEY_DIR, join(homedir(), '.near-credentials', 'testnet')].filter(Boolean)) {
    try { return JSON.parse(readFileSync(join(dir, `${ROOT}.json`), 'utf8')).private_key; } catch {}
  }
  return null;
}
const KEY = loadKey();
export const CONTRACT = process.env.NEAR_CONTRACT_ID || (ROOT ? `bazaar.${ROOT}` : 'bazaar.mock');
const PUBLIC_URL = process.env.PUBLIC_URL || 'http://localhost:3000';
export const GOLD_TO_NEAR = Number(process.env.GOLD_TO_NEAR || 0.00002); // 1 gold = 0.00002 NEAR
const SEED_NEAR = process.env.MERCHANT_SEED_NEAR || '0.2';
export const EXPLORER = 'https://testnet.nearblocks.io';
export const TREASURY = ROOT ? `treasury.${ROOT}` : 'treasury.mock';
export const testnetAvailable = Boolean(ROOT && KEY);
const GOODS = ['saffron', 'silk', 'tea', 'salt'];
const TGAS = n => BigInt(n) * 1_000_000_000_000n;

let provider, root, pubKey;
const accounts = new Map();
if (testnetAvailable) {
  provider = new FailoverRpcProvider(RPCS.map(url => new JsonRpcProvider({ url })));
  root = new Account(ROOT, provider, KEY);
  pubKey = KeyPair.fromString(KEY).getPublicKey().toString();
}
const acct = id => { if (!accounts.has(id)) accounts.set(id, new Account(id, provider, KEY)); return accounts.get(id); };
const hashOf = r => r?.transaction?.hash || r?.transaction_outcome?.id;
const yocto = gold => nearToYocto((Math.max(0, gold) * GOLD_TO_NEAR).toFixed(6));
const fmtNear = gold => (gold * GOLD_TO_NEAR).toFixed(5);
// escrow calls use well under 10 TGas; 30 TGas reserves about 0.03 NEAR of the caller's balance
const DEAL_GAS = 30;
const GAS_RESERVE = '0.04';

// ---------- signing queues (testnet) ----------
const queues = new Map();
const TRANSIENT = /Exceeded \d+ providers|429|Too Many|timeout|ETIMEDOUT|ECONNRESET|fetch failed|InvalidNonce|503|502/i;
async function retry(fn, tries = 4) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries - 1 || !TRANSIENT.test(e.message || '')) throw e;
      await new Promise(r => setTimeout(r, 800 * 2 ** i));
    }
  }
}
const pendingTx = () => [...queues.values()].reduce((t, q) => t + q.n, 0);

async function exists(id) {
  try { await provider.viewAccount({ accountId: id, finality: 'final' }); return true; } catch { return false; }
}
const view = (method, args) => provider.callFunction({ contractId: CONTRACT, method, args, finality: 'optimistic' });

// `table` picks which set of live accounts this game plays with: table 0 uses kasim.<root> and
// charter-kasim, table n uses kasim-t<n+1>.<root> and charter-kasim-t<n+1>.
export function makeChain(live, table = 0) {
  live = live && testnetAvailable;
  const sfx = live && table ? `-t${table + 1}` : '';
  const feed = [];
  let mockSeq = 0, dealSeq = 0;
  const mockHash = () => `sim-${(++mockSeq).toString(36).padStart(5, '0')}`;
  const push = (kind, text, hash) => {
    feed.unshift({ at: Date.now(), kind, text, hash: hash || null, url: live && hash ? `${EXPLORER}/txns/${hash}` : null });
    feed.length = Math.min(feed.length, 80);
  };
  // in practice mode every "transaction" resolves immediately with a simulated hash
  const enqueue = (signer, label, fn) => {
    if (!live) return Promise.resolve();
    const q = queues.get(signer) || { p: Promise.resolve(), n: 0 };
    q.n++;
    q.p = q.p.then(() => retry(fn)).catch(e => push('error', `${label} failed: ${e.message?.slice(0, 160)}`)).finally(() => q.n--);
    queues.set(signer, q);
    return q.p;
  };
  const walletOf = slug => (live ? `${slug}${sfx}.${ROOT}` : `${slug}.bazaar.near`);
  const send = (from, to, amount) => acct(from).signAndSendTransaction({ receiverId: to, actions: [actions.transfer(amount)], waitUntil: 'INCLUDED' });
  const call = (signer, method, args, { deposit = 0n, gas = 100 } = {}) =>
    acct(signer).callFunctionRaw({ contractId: CONTRACT, methodName: method, args, deposit, gas: TGAS(gas) });

  // make sure a wallet can afford `gold` plus `reserve` NEAR for fees (a function call reserves its
  // full prepaid gas up front); if not, the treasury lends the difference (visible on-chain)
  async function ensureFunds(m, gold, reserve = '0.01') {
    const need = BigInt(yocto(gold)) + nearToYocto(reserve);
    const bal = await acct(m.wallet).getBalance();
    if (bal >= need) return;
    const r = await send(TREASURY, m.wallet, need - bal + nearToYocto('0.02'));
    push('loan', `The treasury advances ${m.player ? 'you' : m.name} a little working capital.`, hashOf(r));
  }

  // a new season starts every stall with the same working capital (SEED_NEAR): surplus earned
  // last season goes back to the treasury, then short wallets are staked from it
  async function rebalance(merchants) {
    const seed = nearToYocto(SEED_NEAR), slack = nearToYocto('0.05');
    const balanceOf = id => acct(id).getBalance().catch(() => null);
    const name = m => (m.player ? 'Your stall' : `${m.name}'s stall`);
    const before = await Promise.all(merchants.map(m => balanceOf(m.wallet)));
    const returning = merchants.filter((m, i) => before[i] !== null && before[i] > seed + slack);
    await Promise.all(returning.map(m => enqueue(m.wallet, `return ${m.wallet}`, async () => {
      const surplus = (await balanceOf(m.wallet)) - seed;
      if (surplus <= slack) return;
      push('settle', `New season: ${name(m)} returns ${Number(yoctoToNear(surplus)).toFixed(3)} NEAR of last season's surplus to the treasury.`, hashOf(await send(m.wallet, TREASURY, surplus)));
    })));
    // a transfer is credited a block after it is included
    if (returning.length) await new Promise(r => setTimeout(r, 3000));
    for (const [i, m] of merchants.entries()) {
      if (before[i] === null || before[i] >= seed / 2n) continue;
      const amount = seed - before[i];
      await enqueue(TREASURY, `stake ${m.wallet}`, async () => {
        // the treasury keeps a small reserve for loans; the Vizier covers a shortfall
        const from = (await balanceOf(TREASURY)) > amount + nearToYocto('0.1') ? TREASURY : ROOT;
        push('wallet', `The ${from === TREASURY ? 'treasury' : 'Vizier'} tops ${m.player ? 'your stall' : `${m.name}'s stall`} up to ${SEED_NEAR} NEAR of working capital.`, hashOf(await send(from, m.wallet, amount)));
      });
    }
  }

  const holdings = merchants => merchants.flatMap(m => GOODS.map(g => ({ account_id: m.wallet, token_id: g, amount: String(Math.max(0, Math.floor(m.inventory[g]))) })));

  return {
    live,
    feed,
    pending: () => (live ? pendingTx() : 0),
    info: () => ({ mode: live ? 'testnet' : 'practice', table: live ? table + 1 : null, testnetAvailable, root: ROOT || null, contract: live ? CONTRACT : null, treasury: live ? TREASURY : null, explorer: EXPLORER, goldToNear: GOLD_TO_NEAR, pending: live ? pendingTx() : 0 }),
    explorerAccount: id => (live ? `${EXPLORER}/address/${id}` : null),

    // this game's seat was given to someone else: stop signing, keep the feed
    goPractice(reason) {
      if (!live) return;
      live = false;
      push('error', reason);
    },

    async setupMerchants(merchants, ownerOf) {
      for (const m of merchants) { m.wallet = walletOf(m.slug); m.tokenId = `charter-${m.slug}${sfx}`; }
      if (!live) {
        for (const m of merchants) push('mint', `${m.player ? 'Your' : m.name + "'s"} charter is minted. The stall now owns its own wallet.`, mockHash());
        return;
      }
      await enqueue(ROOT, 'treasury', async () => {
        if (!(await exists(TREASURY))) {
          const r = await root.createSubAccount({ accountOrPrefix: 'treasury', publicKey: pubKey, nearToTransfer: nearToYocto(process.env.TREASURY_SEED_NEAR || '2.5') });
          push('wallet', 'The town treasury opens its vault.', hashOf(r));
        }
      });
      for (const m of merchants) {
        await enqueue(ROOT, `wallet ${m.wallet}`, async () => {
          if (!(await exists(m.wallet))) {
            // root pays only the account's storage; the treasury stakes its working capital below
            const r = await root.createSubAccount({ accountOrPrefix: m.wallet.split('.')[0], publicKey: pubKey, nearToTransfer: nearToYocto('0.01') });
            push('wallet', `${m.player ? 'Your stall' : m.name + "'s stall"} gets its own NEAR wallet.`, hashOf(r));
          }
        });
        await enqueue(ROOT, `charter ${m.tokenId}`, async () => {
          const existing = await view('nft_token', { token_id: m.tokenId }).catch(() => null);
          if (existing) {
            if (existing.owner_id !== ownerOf(m)) {
              const r = await call(existing.owner_id, 'nft_transfer', { receiver_id: ownerOf(m), token_id: m.tokenId, memo: 'New season: the charter returns to its merchant' }, { deposit: 1n, gas: 50 });
              push('transfer', `New season: ${m.player ? 'your' : m.name + "'s"} charter returns to its own stall.`, hashOf(r));
            }
            return;
          }
          const r = await call(ROOT, 'mint_charter', { token_id: m.tokenId, owner_id: ownerOf(m), name: m.name, wallet: m.wallet, persona: m.persona, media: `${PUBLIC_URL}/art/${m.art || m.slug}.webp` }, { deposit: nearToYocto('0.02') });
          push('mint', `${m.player ? 'Your' : m.name + "'s"} charter is minted. The stall now owns its own wallet.`, hashOf(r));
        });
      }
      await rebalance(merchants);
      // a new season starts with empty warehouses
      enqueue(ROOT, 'reset goods', async () => {
        const r = await call(ROOT, 'sync_goods', { holdings: holdings(merchants) }, { gas: 200 });
        push('goods', 'New season: every warehouse starts empty.', hashOf(r));
      });
    },

    // every 5 days: P&L transfers + goods mirror + dynamic NFT metadata
    settle(day, pnlRows, merchants, worth) {
      const byId = Object.fromEntries(merchants.map(m => [m.id, m]));
      for (const { merchant, pnl } of pnlRows) {
        const m = byId[merchant];
        if (!m || Math.abs(pnl) * GOLD_TO_NEAR < 0.00001) continue;
        const [from, to] = pnl > 0 ? [TREASURY, m.wallet] : [m.wallet, TREASURY];
        const text = `${m.player ? 'You' : m.name} ${pnl > 0 ? 'earned' : 'lost'} ${Math.abs(pnl).toFixed(0)} coins over days ${Math.max(1, day - 4)}–${day}, paid ${pnl > 0 ? 'out by' : 'in to'} the treasury.`;
        if (!live) { push('settle', text, mockHash()); continue; }
        enqueue(from, `settle ${m.slug}`, async () => {
          if (pnl < 0) await ensureFunds(m, -pnl);
          push('settle', text, hashOf(await send(from, to, yocto(Math.abs(pnl)))));
        });
      }
      const goodsText = `Day ${day}: every stall's stock of saffron, silk, tea and salt is recorded on-chain.`;
      const nftText = `Day ${day}: each charter NFT is updated with its house's net worth and strategy.`;
      if (!live) { push('goods', goodsText, mockHash()); push('update', nftText, mockHash()); return; }
      enqueue(ROOT, 'sync goods', async () => push('goods', goodsText, hashOf(await call(ROOT, 'sync_goods', { holdings: holdings(merchants) }, { gas: 200 }))));
      enqueue(ROOT, 'update charters', async () => push('update', nftText, hashOf(await call(ROOT, 'update_charters', {
        day, updates: merchants.map(m => ({ token_id: m.tokenId, net_worth: Math.round(worth(m)), gold: Math.round(m.gold), stance: (m.ownedBy ? `vassal of ${m.ownedBy} · ` : '') + m.doctrine.stance + (m.doctrine.focus ? `:${m.doctrine.focus}` : ''), bankrupt: m.bankrupt })),
      }, { gas: 150 }))));
    },

    // goods deal between houses, settled atomically through the contract's escrow:
    // the seller's wallet locks the goods for this buyer at this price (offer_goods), then the
    // buyer's wallet pays and receives them in one transaction (accept_goods).
    recordDeal(buyer, seller, good, qty, total, merchants) {
      const lockText = `${seller.name}'s stall locks ${qty} ${good} in escrow for ${buyer.player ? 'you' : buyer.name}, signed by its own wallet.`;
      const dealText = `${buyer.player ? 'You pay' : buyer.name + ' pays'} ${seller.name} ${Math.round(total)} coins (${fmtNear(total)} NEAR) and receive${buyer.player ? '' : 's'} the ${good} in the same transaction.`;
      if (!live) { push('escrow', lockText, mockHash()); push('deal', dealText, mockHash()); return; }
      const offerId = `${seller.slug}-${buyer.slug}${sfx}-${Date.now().toString(36)}-${(++dealSeq).toString(36)}`;
      const price = yocto(total);
      let locked = false;
      // the Vizier first mirrors both houses' pre-deal stock so the seller's on-chain balance exists
      const pre = merchants.filter(m => m === buyer || m === seller).map(m => ({ account_id: m.wallet, token_id: good, amount: String(Math.floor(m.inventory[good] + (m === seller ? qty : -qty))) }));
      enqueue(ROOT, 'pre-deal sync', () => call(ROOT, 'sync_goods', { holdings: pre }))
        .then(() => enqueue(seller.wallet, 'escrow goods', async () => {
          await ensureFunds(seller, 0, GAS_RESERVE);
          push('escrow', lockText, hashOf(await call(seller.wallet, 'offer_goods', { offer_id: offerId, buyer_id: buyer.wallet, token_id: good, amount: String(qty), price: price.toString() }, { deposit: 1n, gas: DEAL_GAS })));
          locked = true;
        }))
        .then(() => enqueue(buyer.wallet, 'accept deal', async () => {
          if (!locked) return; // nothing in escrow, so nothing to pay for
          await ensureFunds(buyer, total, GAS_RESERVE);
          push('deal', dealText, hashOf(await call(buyer.wallet, 'accept_goods', { offer_id: offerId }, { deposit: price, gas: DEAL_GAS })));
        }));
    },

    // charter sale: Vizier lists it, then the buyer's own wallet buys it with the price attached
    recordCharterSale(buyer, target, price, reason) {
      const text = `${buyer.player ? 'You buy' : buyer.name + ' buys'} ${target.name}'s charter for ${Math.round(price)} coins (${fmtNear(price)} NEAR). The NFT moves to the buyer's stall.`;
      if (!live) { push('listed', `${target.name}'s charter is put up for sale (${reason}).`, mockHash()); push('takeover', text, mockHash()); return; }
      const deposit = yocto(price);
      enqueue(ROOT, 'list charter', async () => {
        if (target.bankrupt) await call(ROOT, 'update_charters', { day: target.bankruptDay || 0, updates: [{ token_id: target.tokenId, net_worth: Math.round(target.gold), gold: Math.round(target.gold), stance: 'bankrupt', bankrupt: true }] });
        push('listed', `${target.name}'s charter is put up for sale (${reason}).`, hashOf(await call(ROOT, 'list_charter', { token_id: target.tokenId, price: deposit.toString(), reason })));
      }).then(() => enqueue(buyer.wallet, 'buy charter', async () => {
        await ensureFunds(buyer, price);
        push('takeover', text, hashOf(await call(buyer.wallet, 'buy_charter', { token_id: target.tokenId, buyer_token_id: buyer.tokenId }, { deposit, gas: 100 })));
      }));
    },
  };
}

export async function walletBalances(merchants) {
  if (!testnetAvailable) return {};
  const out = {};
  await Promise.all(merchants.map(async m => {
    try { out[m.id] = Number(yoctoToNear(await acct(m.wallet).getBalance())).toFixed(4); } catch { out[m.id] = null; }
  }));
  return out;
}
