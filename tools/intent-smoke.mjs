// End-to-end check of intent settlement on testnet with two live-table wallets (table 3).
// Usage: node --env-file=.env tools/intent-smoke.mjs
import { Account, JsonRpcProvider, KeyPair, nearToYocto } from 'near-api-js';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
const ROOT = process.env.NEAR_ACCOUNT_ID, CONTRACT = `bazaar.${ROOT}`, TREASURY = `treasury.${ROOT}`;
const KEY = JSON.parse(readFileSync(join(process.env.NEAR_KEY_DIR || join(homedir(), '.near-credentials', 'testnet'), `${ROOT}.json`), 'utf8')).private_key;
const provider = new JsonRpcProvider({ url: 'https://rpc.testnet.near.org' });
const A = id => new Account(id, provider, KEY);
const view = (method, args) => provider.callFunction({ contractId: CONTRACT, method, args, finality: 'optimistic' });
const call = (who, method, args, deposit = 0n, gas = 30) => A(who).callFunctionRaw({ contractId: CONTRACT, methodName: method, args, deposit, gas: BigInt(gas) * 10n ** 12n });
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const bstr = s => { const d = Buffer.from(s, 'utf8'); return Buffer.concat([u32(d.length), d]); };
const kp = KeyPair.fromString(KEY);
const sign = intent => { const message = JSON.stringify(intent), nonce = randomBytes(32); const bytes = Buffer.concat([u32(2147484061), bstr(message), nonce, bstr(CONTRACT), Buffer.from([0])]); return { message, nonce: [...nonce], recipient: CONTRACT, public_key: kp.getPublicKey().toString(), signature: [...kp.sign(createHash('sha256').update(bytes).digest()).signature] }; };
const seller = `kasim-t3.${ROOT}`, buyer = `vey-t3.${ROOT}`;
for (const w of [seller, buyer]) if (!(await view('signers_of', { account_id: w })).includes(kp.getPublicKey().toString())) console.log('register', w, (await call(w, 'register_signer', {}, 0n, 10)).transaction.hash);
if (BigInt(await view('vault_of', { token_id: 'charter-vey-t3' })) < nearToYocto('0.005')) console.log('vault deposit', (await call(buyer, 'vault_deposit', { token_id: 'charter-vey-t3' }, nearToYocto('0.01'), 10)).transaction.hash);
console.log('sync', (await call(ROOT, 'sync_goods', { holdings: [{ account_id: seller, token_id: 'silk', amount: '5' }] })).transaction.hash);
const before = { sv: await view('vault_of', { token_id: 'charter-kasim-t3' }), bv: await view('vault_of', { token_id: 'charter-vey-t3' }) };
const deadline_ms = Date.now() + 600000, price = nearToYocto('0.001');
const r = await call(TREASURY, 'execute_intents', { intents: [
  sign({ signer_id: seller, charter: 'charter-kasim-t3', deadline_ms, near: price.toString(), goods: { silk: -2 }, memo: 'smoke test' }),
  sign({ signer_id: buyer, charter: 'charter-vey-t3', deadline_ms, near: (-price).toString(), goods: { silk: 2 }, memo: 'smoke test' }),
] }, 0n, 60);
console.log('execute_intents', r.transaction.hash, JSON.stringify(r.status).slice(0, 60));
console.log('logs', r.receipts_outcome.flatMap(o => o.outcome.logs).map(l => l.slice(0, 140)));
console.log('vaults before', before, 'after', { sv: await view('vault_of', { token_id: 'charter-kasim-t3' }), bv: await view('vault_of', { token_id: 'charter-vey-t3' }) });
console.log('silk', await view('mt_balance_of', { account_id: seller, token_id: 'silk' }), await view('mt_balance_of', { account_id: buyer, token_id: 'silk' }));
