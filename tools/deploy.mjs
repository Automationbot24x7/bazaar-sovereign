// One-time testnet deploy: creates charters.<root>, deploys the contract, initialises it.
// Usage: NEAR_ACCOUNT_ID=<you>.testnet node tools/deploy.mjs
import { Account, JsonRpcProvider, KeyPair, nearToYocto, yoctoToNear } from 'near-api-js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.env.NEAR_ACCOUNT_ID;
if (!ROOT) throw new Error('Set NEAR_ACCOUNT_ID');
const KEY = process.env.NEAR_PRIVATE_KEY || JSON.parse(readFileSync(join(process.env.NEAR_KEY_DIR || join(homedir(), '.near-credentials', 'testnet'), `${ROOT}.json`), 'utf8')).private_key;
const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC || 'https://rpc.testnet.near.org' });
const root = new Account(ROOT, provider, KEY);
const CONTRACT = process.env.NEAR_CONTRACT_ID || `bazaar.${ROOT}`;
const wasm = readFileSync(new URL('../contract/out/bazaar_charters.wasm', import.meta.url));

console.log(`root ${ROOT} balance: ${yoctoToNear(await root.getBalance())} NEAR`);
const exists = await provider.viewAccount({ accountId: CONTRACT, finality: 'final' }).then(() => true, () => false);
if (!exists) {
  const r = await root.createSubAccount({ accountOrPrefix: CONTRACT.split('.')[0], publicKey: KeyPair.fromString(KEY).getPublicKey().toString(), nearToTransfer: nearToYocto('3') });
  console.log('created', CONTRACT, r.transaction.hash);
}
const contract = new Account(CONTRACT, provider, KEY);
const d = await contract.deployContract(wasm);
console.log('deployed', wasm.length, 'bytes', d.transaction.hash);
try {
  const i = await contract.callFunctionRaw({ contractId: CONTRACT, methodName: 'new', args: { owner_id: ROOT, treasury_id: `treasury.${ROOT}` } });
  console.log('initialised, Vizier =', ROOT, i.transaction.hash);
} catch (e) {
  console.log('init skipped (already initialised?):', e.message.slice(0, 120));
}
console.log('metadata:', await provider.callFunction({ contractId: CONTRACT, method: 'nft_metadata', args: {}, finality: 'optimistic' }));
console.log(`\nExplorer: https://testnet.nearblocks.io/address/${CONTRACT}`);
