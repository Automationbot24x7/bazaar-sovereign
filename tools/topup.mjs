// Send testnet NEAR from the root account to another account (e.g. the contract, for storage).
// Usage: node --env-file=.env tools/topup.mjs <account> <near>
import { Account, JsonRpcProvider, nearToYocto } from 'near-api-js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const ROOT = process.env.NEAR_ACCOUNT_ID;
const KEY = process.env.NEAR_PRIVATE_KEY || JSON.parse(readFileSync(join(process.env.NEAR_KEY_DIR || join(homedir(), '.near-credentials', 'testnet'), `${ROOT}.json`), 'utf8')).private_key;
const [to, amount] = process.argv.slice(2);
const root = new Account(ROOT, new JsonRpcProvider({ url: process.env.NEAR_RPC || 'https://rpc.testnet.near.org' }), KEY);
const r = await root.transfer({ receiverId: to, amount: nearToYocto(amount) });
console.log('sent', amount, 'NEAR to', to, r.transaction.hash);
