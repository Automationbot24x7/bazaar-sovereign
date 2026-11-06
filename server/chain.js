// NEAR layer. Two modes:
//  - "testnet": real NEAR testnet. Each merchant charter is an NFT on our contract and
//    owns a real sub-account wallet (e.g. kasim.<root>.testnet). Profits/losses settle
//    as real NEAR transfers between the town treasury (<root>) and merchant wallets.
//  - "mock": same API, no network (so the game runs for anyone instantly).
import { Account, JsonRpcProvider, FailoverRpcProvider, KeyPair, actions, nearToYocto, yoctoToNear } from 'near-api-js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const RPCS = (process.env.NEAR_RPC || 'https://test.rpc.fastnear.com,https://rpc.testnet.near.org').split(',');
const ROOT = process.env.NEAR_ACCOUNT_ID;           // e.g. bazaar-sovereign-2026.testnet (town treasury + game oracle)
// Key: env var, or the NEAR CLI legacy keychain (~/.near-credentials/testnet/<account>.json)
function loadKey() {
  if (process.env.NEAR_PRIVATE_KEY) return process.env.NEAR_PRIVATE_KEY;
  if (!ROOT) return null;
  try { return JSON.parse(readFileSync(join(homedir(), '.near-credentials', 'testnet', `${ROOT}.json`), 'utf8')).private_key; } catch { return null; }
}
const KEY = loadKey();
const CONTRACT = process.env.NEAR_CONTRACT_ID || (ROOT ? `charters.${ROOT}` : null);
const PUBLIC_URL = process.env.PUBLIC_URL || 'http://localhost:3000';
const ART = { player: 'player', teodora: 'teodora', kasim: 'kasim', vey: 'vey', ozzo: 'ozzo' };
export const GOLD_TO_NEAR = Number(process.env.GOLD_TO_NEAR || 0.0001); // 1 gold = 0.0001 NEAR
const SEED_NEAR = process.env.MERCHANT_SEED_NEAR || '0.2';
export const EXPLORER = 'https://testnet.nearblocks.io';

export const chainMode = ROOT && KEY ? 'testnet' : 'mock';
export const feed = []; // recent on-chain activity for the UI ticker
const push = (kind, text, hash, extra = {}) => {
  feed.unshift({ at: Date.now(), kind, text, hash, url: hash && !hash.startsWith('mock') ? `${EXPLORER}/txns/${hash}` : null, ...extra });
  feed.length = Math.min(feed.length, 80);
};

let provider, root, pubKey;
const accounts = new Map();
if (chainMode === 'testnet') {
  provider = new FailoverRpcProvider(RPCS.map(url => new JsonRpcProvider({ url })));
  root = new Account(ROOT, provider, KEY);
  pubKey = KeyPair.fromString(KEY).getPublicKey().toString();
}
const acct = id => { if (!accounts.has(id)) accounts.set(id, new Account(id, provider, KEY)); return accounts.get(id); };
export const TREASURY = ROOT ? `treasury.${ROOT}` : 'treasury.mock'; // the town treasury pays and collects merchant P&L
// fast transfer: return once the tx is included in a block
const send = (from, to, amount) => acct(from).signAndSendTransaction({ receiverId: to, actions: [actions.transfer(amount)], waitUntil: 'INCLUDED' });
export const walletOf = slug => (chainMode === 'testnet' ? `${slug}.${ROOT}` : `${slug}.bazaar.mock`);

// One queue per signing account: nonces of one signer never collide, different signers run
// in parallel, and the chain never blocks the game loop.
const queues = new Map();
// Public testnet RPCs rate-limit bursts; retry transient failures with backoff.
const TRANSIENT = /Exceeded \d+ providers|429|Too Many|timeout|ETIMEDOUT|ECONNRESET|fetch failed|InvalidNonce|503|502/i;
async function retry(fn, tries = 4) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries - 1 || !TRANSIENT.test(e.message || '')) throw e;
      await new Promise(r => setTimeout(r, 800 * 2 ** i));
    }
  }
}
export const pending = () => [...queues.values()].reduce((t, q) => t + q.n, 0);
const enqueue = (signer, label, fn) => {
  const q = queues.get(signer) || { p: Promise.resolve(), n: 0 };
  q.n++;
  q.p = q.p.then(() => retry(fn)).catch(e => push('error', `${label} failed: ${e.message?.slice(0, 160)}`)).finally(() => q.n--);
  queues.set(signer, q);
  return q.p;
};
let mockSeq = 0;
const mockHash = () => `mock${(++mockSeq).toString(36).padStart(6, '0')}`;
const hashOf = r => r?.transaction?.hash || r?.transaction_outcome?.id;

async function exists(id) {
  try { await provider.viewAccount({ accountId: id, finality: 'final' }); return true; } catch { return false; }
}

// ---------- setup: wallets + charters ----------
export async function setupMerchants(merchants, ownerOf) {
  for (const m of merchants) {
    m.wallet = walletOf(m.slug);
    m.tokenId = `charter-${m.slug}`;
  }
  if (chainMode === 'mock') {
    for (const m of merchants) push('mint', `Charter #${m.tokenId} minted → wallet ${m.wallet}`, mockHash());
    return;
  }
  await enqueue(ROOT, 'create treasury', async () => {
    if (!(await exists(TREASURY))) {
      const r = await root.createSubAccount({ accountOrPrefix: 'treasury', publicKey: pubKey, nearToTransfer: nearToYocto(process.env.TREASURY_SEED_NEAR || '2.5') });
      push('wallet', `Opened the town treasury ${TREASURY}`, hashOf(r));
    }
  });
  for (const m of merchants) {
    await enqueue(ROOT, `create ${m.wallet}`, async () => {
      if (!(await exists(m.wallet))) {
        const r = await root.createSubAccount({ accountOrPrefix: m.slug, publicKey: pubKey, nearToTransfer: nearToYocto(SEED_NEAR) });
        push('wallet', `Opened wallet ${m.wallet} with ${SEED_NEAR} NEAR`, hashOf(r));
      }
    });
    await enqueue(ROOT, `mint ${m.tokenId}`, async () => {
      const existing = await root.provider.callFunction({ contractId: CONTRACT, method: 'nft_token', args: { token_id: m.tokenId }, finality: 'optimistic' }).catch(() => null);
      if (existing) {
        // Reset ownership for a new game: the charter goes back to its own merchant wallet.
        if (existing.owner_id !== ownerOf(m)) {
          const r = await acct(existing.owner_id).callFunctionRaw({ contractId: CONTRACT, methodName: 'nft_transfer', deposit: 1n, gas: 50_000_000_000_000n, args: { receiver_id: ownerOf(m), token_id: m.tokenId, memo: 'New game: charter returns to its merchant' } });
          push('transfer', `Charter ${m.tokenId} returned to ${ownerOf(m)}`, hashOf(r));
        }
        return;
      }
      const r = await root.callFunctionRaw({
        contractId: CONTRACT, methodName: 'mint_charter', gas: 100_000_000_000_000n, deposit: nearToYocto('0.02'),
        args: { token_id: m.tokenId, owner_id: ownerOf(m), name: m.name, wallet: m.wallet, persona: m.persona, media: `${PUBLIC_URL}/art/${ART[m.slug] || 'player'}.webp` },
      });
      push('mint', `Minted charter ${m.tokenId} (NFT) → owner ${ownerOf(m)}`, hashOf(r));
    });
  }
}

// ---------- settlement: batch P&L into real transfers ----------
export function settle(day, rows, merchants) {
  const byId = Object.fromEntries(merchants.map(m => [m.id, m]));
  for (const { merchant, pnl } of rows) {
    const m = byId[merchant];
    const near = Math.abs(pnl) * GOLD_TO_NEAR;
    if (near < 0.00001) continue;
    const amount = nearToYocto(near.toFixed(6));
    const [from, to] = pnl > 0 ? [TREASURY, m.wallet] : [m.wallet, TREASURY];
    const text = `Day ${day} · ${m.name} ${pnl > 0 ? 'earned' : 'paid'} ${Math.abs(pnl).toFixed(0)}g → ${near.toFixed(4)} NEAR ${pnl > 0 ? 'treasury → ' + m.slug : m.slug + ' → treasury'}`;
    if (chainMode === 'mock') { push('settle', text, mockHash()); continue; }
    enqueue(from, `settle ${m.slug}`, async () => {
      const r = await send(from, to, amount);
      push('settle', text, hashOf(r));
    });
  }
}

// Dynamic NFT: write the merchant's live state into its charter metadata.
export function updateCharters(day, merchants, worth) {
  if (chainMode === 'mock') { push('update', `Day ${day} · ${merchants.length} charters updated (net worth, stance)`, mockHash()); return; }
  enqueue(ROOT, 'update charters', async () => {
    const r = await root.callFunctionRaw({
      contractId: CONTRACT, methodName: 'update_charters', gas: 150_000_000_000_000n,
      args: { day, updates: merchants.map(m => ({ token_id: m.tokenId, net_worth: Math.round(worth(m)), gold: Math.round(m.gold), stance: m.doctrine.stance + (m.doctrine.focus ? `:${m.doctrine.focus}` : ''), bankrupt: m.bankrupt })) },
    });
    push('update', `Day ${day} · charters updated on-chain (dynamic NFT metadata)`, hashOf(r));
  });
}

// Takeover: the charter NFT moves to the buyer and the price is paid wallet-to-wallet.
export function recordTakeover(buyer, target, price, newOwner) {
  const near = (price * GOLD_TO_NEAR).toFixed(6);
  const text = `${buyer.name} took over ${target.name}: charter ${target.tokenId} → ${newOwner}, paid ${price}g (${near} NEAR)`;
  if (chainMode === 'mock') { push('takeover', text, mockHash()); return; }
  // 1) buyer's wallet pays the Vizier (buyer's queue)
  enqueue(buyer.wallet, 'takeover payment', async () => {
    const pay = await send(buyer.wallet, TREASURY, nearToYocto(near));
    push('settle', `${buyer.name} paid the treasury ${near} NEAR for the ${target.name} charter`, hashOf(pay));
  });
  // 2) Vizier records the bankruptcy (if not synced yet) and moves the NFT (Vizier's queue)
  enqueue(ROOT, 'takeover', async () => {
    await root.callFunctionRaw({
      contractId: CONTRACT, methodName: 'update_charters', gas: 100_000_000_000_000n,
      args: { day: target.bankruptDay || 0, updates: [{ token_id: target.tokenId, net_worth: Math.round(target.gold), gold: Math.round(target.gold), stance: 'bankrupt', bankrupt: true }] },
    });
    const r = await root.callFunctionRaw({
      contractId: CONTRACT, methodName: 'takeover', gas: 100_000_000_000_000n, deposit: 1n,
      args: { token_id: target.tokenId, new_owner_id: newOwner, price_gold: Math.round(price), buyer_token_id: buyer.tokenId },
    });
    push('takeover', text, hashOf(r));
  });
}

export async function balances(merchants) {
  if (chainMode === 'mock') return {};
  const out = {};
  await Promise.all(merchants.map(async m => {
    try { out[m.id] = Number(yoctoToNear(await acct(m.wallet).getBalance())).toFixed(4); } catch { out[m.id] = null; }
  }));
  return out;
}

export const chainInfo = () => ({ pending: pending(), mode: chainMode, root: ROOT || null, contract: chainMode === 'testnet' ? CONTRACT : null, explorer: EXPLORER, goldToNear: GOLD_TO_NEAR });
