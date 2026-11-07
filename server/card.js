// Living charter art: the NFT's image is a card drawn from the NFT's own on-chain state.
// GET /charter/<token_id>.svg reads nft_token + vault_of from NEAR testnet (cached briefly) and draws the
// house's portrait, net worth, strategy, vault, absorbed houses and a BANKRUPT stamp when it falls.
// The charter's metadata `media` points here, so wallets and explorers show the business as it is now.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonRpcProvider } from 'near-api-js';
import { CONTRACT, testnetAvailable } from './chain.js';

const RPC = (process.env.NEAR_RPC || 'https://test.rpc.fastnear.com').split(',')[0];
let provider;
const cache = new Map();          // token -> { at, svg }
const portraits = new Map();      // art -> data URI
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const HOUSE = { player: '#e0a526', teodora: '#5aa469', kasim: '#d35d47', vey: '#8e6cc9', ozzo: '#3b8bd0', magnate: '#c9a227' };

async function portrait(art) {
  if (!portraits.has(art)) {
    const file = join(process.cwd(), 'public', 'art', `${/^[a-z]+$/.test(art) ? art : 'ruin'}.webp`);
    const data = await readFile(file).catch(() => null);
    portraits.set(art, data ? `data:image/webp;base64,${data.toString('base64')}` : '');
  }
  return portraits.get(art);
}

async function chainState(token) {
  provider ||= new JsonRpcProvider({ url: RPC });
  const view = (method, args) => provider.callFunction({ contractId: CONTRACT, method, args, finality: 'optimistic' });
  const [nft, vault] = await Promise.all([view('nft_token', { token_id: token }), view('vault_of', { token_id: token }).catch(() => '0')]);
  if (!nft) return null;
  const extra = JSON.parse(nft.metadata?.extra || '{}');
  return { owner: nft.owner_id, title: nft.metadata?.title || token, extra, vault: Number(BigInt(vault) / 10n ** 18n) / 1e6 };
}

function draw(token, s, img) {
  const slug = token.replace(/^charter-/, '').replace(/-t\d+$/, '');
  const c = HOUSE[slug] || '#e0a526', x = s.extra || {};
  const name = esc(x.name || s.title.replace(/ — .*/, ''));
  const crowns = '♛'.repeat(Math.min(5, 1 + (x.takeovers || 0)));
  const stance = esc(String(x.stance || 'steady').replace(/:/g, ' · '));
  const worth = Number(x.net_worth ?? 0);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840" viewBox="0 0 600 840" font-family="Georgia, serif">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6e7c4"/><stop offset="1" stop-color="#e8cf9c"/></linearGradient>
    <clipPath id="pic"><rect x="90" y="96" width="420" height="420" rx="26"/></clipPath>
  </defs>
  <rect width="600" height="840" rx="34" fill="#1b1410"/>
  <rect x="14" y="14" width="572" height="812" rx="26" fill="url(#bg)" stroke="${c}" stroke-width="8"/>
  <rect x="30" y="30" width="540" height="780" rx="18" fill="none" stroke="#b8893a" stroke-width="2" stroke-dasharray="2 6"/>
  <text x="300" y="70" text-anchor="middle" font-size="22" fill="#7a5a2a" letter-spacing="4">MERCHANT CHARTER · ${esc(crowns)}</text>
  ${img ? `<image href="${img}" x="90" y="96" width="420" height="420" clip-path="url(#pic)" preserveAspectRatio="xMidYMid slice"${x.bankrupt ? ' opacity="0.45"' : ''}/>` : ''}
  <rect x="90" y="96" width="420" height="420" rx="26" fill="none" stroke="${c}" stroke-width="5"/>
  <text x="300" y="568" text-anchor="middle" font-size="40" font-weight="bold" fill="#3a2614">${name}</text>
  <text x="300" y="612" text-anchor="middle" font-size="24" fill="${worth >= 0 ? '#2f6b3d' : '#9a2c1c'}">net worth ${worth.toLocaleString('en')} coins</text>
  <text x="300" y="648" text-anchor="middle" font-size="21" fill="#5b4326">strategy: ${stance} · day ${esc(x.day ?? 0)}</text>
  <text x="300" y="684" text-anchor="middle" font-size="21" fill="#5b4326">vault: ${s.vault.toFixed(4)} NEAR held by this NFT</text>
  ${(x.absorbed || []).length ? `<text x="300" y="718" text-anchor="middle" font-size="19" fill="#7a5a2a">absorbed: ${esc(x.absorbed.map(a => a.replace(/^charter-/, '')).join(', '))}</text>` : ''}
  <text x="300" y="770" text-anchor="middle" font-size="16" fill="#7a5a2a">owner ${esc(s.owner)}</text>
  <text x="300" y="796" text-anchor="middle" font-size="14" fill="#9a7a4a">Bazaar Sovereign · NEAR testnet · drawn from on-chain state</text>
  ${x.bankrupt ? `<g transform="rotate(-18 300 300)"><rect x="110" y="250" width="380" height="96" rx="12" fill="none" stroke="#b3261e" stroke-width="8"/><text x="300" y="318" text-anchor="middle" font-size="64" font-weight="bold" fill="#b3261e" letter-spacing="6">BANKRUPT</text></g>` : ''}
</svg>`;
}

export async function charterCard(token) {
  if (!/^charter-[a-z]+(-t\d+)?$|^charter-keepsake-\d+$/.test(token)) return null;
  const hit = cache.get(token);
  if (hit && Date.now() - hit.at < 20_000) return hit.svg;
  if (!testnetAvailable && !process.env.NEAR_CONTRACT_ID) return null;
  const s = await chainState(token).catch(() => null);
  if (!s) return hit?.svg || null;
  const art = /^charter-keepsake-/.test(token) ? 'player' : token.replace(/^charter-/, '').replace(/-t\d+$/, '');
  const svg = draw(token, s, await portrait(art));
  cache.set(token, { at: Date.now(), svg });
  return svg;
}
