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
//  * every charter NFT has its own vault of NEAR inside the contract; only the charter's current owner
//    can spend it, so whoever holds the NFT controls the money;
//  * deals between houses (player <-> AI and AI <-> AI) settle by intents: each side's wallet signs a
//    NEP-413 message saying what it gives and gets, and a solver submits the matched pair to
//    execute_intents, which checks both signatures and settles NEAR and goods in one transaction
//    (the older escrow, offer_goods + accept_goods, is kept for charters the Magnate holds);
//  * charter sales: the Vizier lists, the buyer's wallet calls buy_charter with the price attached.
import { Account, JsonRpcProvider, FailoverRpcProvider, KeyPair, actions, nearToYocto, yoctoToNear } from 'near-api-js';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
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
// each charter keeps a small float of NEAR in its own vault to pay for deals
const VAULT_FLOAT = process.env.VAULT_FLOAT_NEAR || '0.03';

// ---------- NEP-413 signed intents ----------
// borsh(u32 tag = 2^31 + 413) ++ borsh({ message, nonce[32], recipient, callback_url: None }), sha256, ed25519
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const bstr = str => { const d = Buffer.from(str, 'utf8'); return Buffer.concat([u32(d.length), d]); };
let signingKey = null;
function signIntent(intent) {
  signingKey ||= KeyPair.fromString(KEY);
  const message = JSON.stringify(intent), nonce = randomBytes(32);
  const bytes = Buffer.concat([u32(2147484061), bstr(message), nonce, bstr(CONTRACT), Buffer.from([0])]);
  const { signature } = signingKey.sign(createHash('sha256').update(bytes).digest());
  return { message, nonce: [...nonce], recipient: CONTRACT, public_key: signingKey.getPublicKey().toString(), signature: [...signature] };
}

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

// a plain provider for existence checks: the failover provider logs every "does not exist" as an error
let probe;
async function exists(id) {
  probe ||= new JsonRpcProvider({ url: RPCS[0] });
  for (let i = 0; i < 3; i++) {
    try { await probe.viewAccount({ accountId: id, finality: 'final' }); return true; } catch (e) {
      if (/does not exist|AccountDoesNotExist|UNKNOWN_ACCOUNT/i.test(`${e.name} ${e.message}`)) return false;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
  return false;
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
  const magnateWallet = walletOf('magnate');
  let ownerFn = m => m.wallet;   // who holds each charter right now (set by setupMerchants)
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
    magnateWallet,
    magnate: { name: 'Baltazar', wallet: magnateWallet, slug: 'magnate', player: false, tokenId: undefined },

    // this game's seat was given to someone else: stop signing, keep the feed
    goPractice(reason) {
      if (!live) return;
      live = false;
      push('error', reason);
    },

    async setupMerchants(merchants, ownerOf) {
      ownerFn = ownerOf;
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
          const media = `${PUBLIC_URL}/charter/${m.tokenId}.svg`;   // a living card drawn from the NFT's own state
          if (existing && existing.metadata?.media !== media && !/localhost/.test(PUBLIC_URL)) {
            await call(ROOT, 'set_media', { token_id: m.tokenId, media }, { gas: 30 }).catch(e => push('error', `charter art for ${m.name}: ${e.message?.slice(0, 80)}`));
          }
          if (existing) {
            if (existing.owner_id !== ownerOf(m)) {
              const r = await call(existing.owner_id, 'nft_transfer', { receiver_id: ownerOf(m), token_id: m.tokenId, memo: 'New season: the charter returns to its merchant' }, { deposit: 1n, gas: 50 });
              push('transfer', `New season: ${m.player ? 'your' : m.name + "'s"} charter returns to its own stall.`, hashOf(r));
            }
            return;
          }
          const r = await call(ROOT, 'mint_charter', { token_id: m.tokenId, owner_id: ownerOf(m), name: m.player ? 'Your House' : m.name, wallet: m.wallet, persona: m.persona, media: `${PUBLIC_URL}/charter/${m.tokenId}.svg` }, { deposit: nearToYocto('0.02') });
          push('mint', `${m.player ? 'Your' : m.name + "'s"} charter is minted. The stall now owns its own wallet.`, hashOf(r));
        });
      }
      await rebalance(merchants);
      // each house's wallet registers the key it signs intents with, and its charter keeps a float in its own vault
      for (const m of merchants) {
        const who = m.player ? 'Your stall' : `${m.name}'s stall`;
        enqueue(m.wallet, `intents setup ${m.wallet}`, async () => {
          const keys = await view('signers_of', { account_id: m.wallet }).catch(() => []);
          if (!keys.includes(pubKey)) push('intent', `${who} registers the key it signs NEP-413 intents with.`, hashOf(await call(m.wallet, 'register_signer', {}, { gas: 10 })));
          const vault = BigInt(await view('vault_of', { token_id: m.tokenId }).catch(() => '0'));
          const want = nearToYocto(VAULT_FLOAT);
          if (vault < want / 2n) {
            await ensureFunds(m, 0, '0.05');
            push('vault', `${m.player ? 'Your' : m.name + "'s"} charter puts ${Number(yoctoToNear(want - vault)).toFixed(3)} NEAR in its own vault: only the charter's owner can spend it.`,
              hashOf(await call(m.wallet, 'vault_deposit', { token_id: m.tokenId }, { deposit: want - vault, gas: 10 })));
          }
        });
      }
      // the Magnate's wallet holds the charters he seizes
      enqueue(ROOT, 'magnate wallet', async () => {
        if (!(await exists(magnateWallet))) {
          const r = await root.createSubAccount({ accountOrPrefix: magnateWallet.split('.')[0], publicKey: pubKey, nearToTransfer: nearToYocto('0.05') });
          push('wallet', 'A wallet is opened for the Golden Caravan Company, should it come to town.', hashOf(r));
        }
      });
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

    // goods deal between houses, settled by intents: the seller's wallet signs "N goods out, P NEAR in",
    // the buyer's wallet signs the mirror image, and a solver submits both to execute_intents, which checks
    // the NEP-413 signatures, that each signer owns the charter it spends from, and that everything nets to
    // zero, then moves the NEAR between the two charters' vaults and the goods between their wallets.
    recordDeal(buyer, seller, good, qty, total, merchants) {
      const sOwner = ownerFn(seller), bOwner = ownerFn(buyer);
      // a charter the Magnate holds has no intent key: fall back to the escrow
      if (live && (sOwner === magnateWallet || bOwner === magnateWallet)) return this.recordDealEscrow(buyer, seller, good, qty, total, merchants);
      const S_ = seller.player ? 'Your wallet' : `${seller.name}'s wallet`, B_ = buyer.player ? 'your wallet' : `${buyer.name}'s wallet`;
      const sellText = `${S_} signs an intent: ${qty} ${good} out, ${fmtNear(total)} NEAR in (NEP-413, off-chain).`;
      const buyText = `${B_[0].toUpperCase() + B_.slice(1)} signs the matching intent: ${fmtNear(total)} NEAR out, ${qty} ${good} in.`;
      const settleText = `A solver settles both signed intents in one transaction: ${qty} ${good} to ${buyer.player ? 'you' : buyer.name}, ${Math.round(total)} coins into ${seller.player ? 'your' : seller.name + "'s"} charter vault.`;
      if (!live) { push('intent', sellText, null); push('intent', buyText, null); push('deal', settleText, mockHash()); return; }
      const price = yocto(total);
      // the Vizier first mirrors both houses' pre-deal stock so the seller's on-chain balance exists
      const pre = merchants.filter(m => m === buyer || m === seller).map(m => ({ account_id: m.wallet, token_id: good, amount: String(Math.floor(m.inventory[good] + (m === seller ? qty : -qty))) }));
      enqueue(ROOT, 'pre-deal sync', () => call(ROOT, 'sync_goods', { holdings: pre }))
        .then(() => enqueue(bOwner, 'vault top-up', async () => {
          const vault = BigInt(await view('vault_of', { token_id: buyer.tokenId }).catch(() => '0'));
          if (vault >= price) return;
          const add = price - vault + nearToYocto(VAULT_FLOAT);
          await ensureFunds({ ...buyer, wallet: bOwner }, 0, (Number(yoctoToNear(add)) + 0.05).toFixed(4));
          push('vault', `${buyer.player ? 'Your' : buyer.name + "'s"} charter vault is topped up to cover the deal.`, hashOf(await call(bOwner, 'vault_deposit', { token_id: buyer.tokenId }, { deposit: add, gas: 10 })));
        }))
        .then(() => enqueue(TREASURY, 'settle intents', async () => {
          const deadline_ms = Date.now() + 15 * 60_000, memo = `${qty} ${good} for ${Math.round(total)} coins`;
          const sell = signIntent({ signer_id: sOwner, charter: seller.tokenId, deadline_ms, near: price.toString(), goods: { [good]: -qty }, memo });
          const buy = signIntent({ signer_id: bOwner, charter: buyer.tokenId, deadline_ms, near: (-price).toString(), goods: { [good]: qty }, memo });
          push('intent', sellText, null); push('intent', buyText, null);
          push('deal', settleText, hashOf(await call(TREASURY, 'execute_intents', { intents: [sell, buy] }, { gas: 60 })));
        }));
    },

    // a fee one house pays another (e.g. to join a pact): two NEAR-only intents, one solver transaction
    recordFee(payer, payee, amount, why) {
      const text = `${payer.player ? 'You pay' : payer.name + ' pays'} ${payee.name} ${Math.round(amount)} coins ${why}: two signed intents, settled charter vault to charter vault.`;
      if (!live) { push('intent', text, mockHash()); return; }
      const price = yocto(amount), pOwner = ownerFn(payer), qOwner = ownerFn(payee);
      if (pOwner === magnateWallet || qOwner === magnateWallet) return;
      enqueue(pOwner, 'vault top-up', async () => {
        const vault = BigInt(await view('vault_of', { token_id: payer.tokenId }).catch(() => '0'));
        if (vault >= price) return;
        const add = price - vault + nearToYocto(VAULT_FLOAT);
        await ensureFunds({ ...payer, wallet: pOwner }, 0, (Number(yoctoToNear(add)) + 0.05).toFixed(4));
        await call(pOwner, 'vault_deposit', { token_id: payer.tokenId }, { deposit: add, gas: 10 });
      }).then(() => enqueue(TREASURY, 'settle fee', async () => {
        const deadline_ms = Date.now() + 15 * 60_000, memo = why;
        const a = signIntent({ signer_id: pOwner, charter: payer.tokenId, deadline_ms, near: (-price).toString(), goods: {}, memo });
        const b = signIntent({ signer_id: qOwner, charter: payee.tokenId, deadline_ms, near: price.toString(), goods: {}, memo });
        push('intent', text, hashOf(await call(TREASURY, 'execute_intents', { intents: [a, b] }, { gas: 60 })));
      }));
    },

    // goods deal between houses, settled atomically through the contract's escrow:
    // the seller's wallet locks the goods for this buyer at this price (offer_goods), then the
    // buyer's wallet pays and receives them in one transaction (accept_goods).
    recordDealEscrow(buyer, seller, good, qty, total, merchants) {
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

    // Moneylenders' Guild: a bond is paid out by the treasury; a repayment (with fees and interest) goes back to it
    recordGuild(m, kind, amount) {
      const who = m.player ? 'You' : m.name, s = m.player ? '' : 's';
      const text = kind === 'borrow'
        ? `${who} borrow${s} ${Math.round(amount)} coins (${fmtNear(amount)} NEAR) from the Moneylenders' Guild, paid out by the treasury.`
        : `${who} repay${s} the Guild ${Math.round(amount)} coins (${fmtNear(amount)} NEAR), fees and interest included.`;
      if (!live) { push('loan', text, mockHash()); return; }
      const [from, to] = kind === 'borrow' ? [TREASURY, m.wallet] : [m.wallet, TREASURY];
      enqueue(from, `guild ${kind}`, async () => {
        if (kind === 'repay') await ensureFunds(m, amount);
        push('loan', text, hashOf(await send(from, to, yocto(amount))));
      });
    },

    // stock destroyed (rats): the Vizier burns it from the holder's on-chain balance
    recordLoss(m, good, text) {
      if (!live) { push('goods', text, mockHash()); return; }
      enqueue(ROOT, 'stock loss', async () => push('goods', text, hashOf(await call(ROOT, 'sync_goods', { holdings: [{ account_id: m.wallet, token_id: good, amount: String(Math.max(0, Math.floor(m.inventory[good]))) }] }))));
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
