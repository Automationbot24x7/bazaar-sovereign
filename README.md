# Bazaar Sovereign

**A living desert bazaar where every merchant is an NFT that owns its own money, and AI minds run your rivals.**

Play free, no wallet needed: **https://bazaar.reconscribe.com**

Built for NEAR HACKATHON 2026 · tracks: **Games With Real Economies**, **NFTs That Do Something**, **Agent Economy**, **AI Swarms**.

You run one of five merchant houses for a 24-day season, trading saffron, silk, tea and salt. Four rival houses are AI agents with their own personalities, memories and grudges: they read rumors, race you for Palace orders, haggle in character, shout their wares, and band together or betray you. On day 6 a magnate arrives who sells below cost to own the bazaar. Houses that run out of money, or drown in debt, go bankrupt, and their **charter NFT, with the money and stock it controls, can be taken over**.

Players never see a wallet popup. The chain is underneath the game loop, not in front of it.

## Judges: a 2-minute tour on the live site

1. **Name your house** (the first screen), then press **▶ Open the bazaar**. A short voiced cutscene plays over an animated painting (Esc skips it).
2. **Click "Corner saffron"** under the order box. Your factor (an AI clerk) reads the plain-words order, replies in character, and your stance badge changes.
3. **Click 🤝 Trade on a rival's stall** and offer to buy some of their stock. The rival answers in character (accepts, refuses, or counters). An accepted deal settles on NEAR as two signed intents (see below): watch the **On NEAR** feed.
4. **Press ⏩ 10 days** to jump to the magnate fight: rally the rivals into a pact (each answers in character, some ask a fee) and buy off his carts.
5. **Press ⛓ Inspect on NEAR**: for every house it reads, live from testnet in your browser, the charter NFT and its current owner, the NFT's own vault of NEAR, the stall wallet, and its NEP-245 goods, next to what that house's AI mind is thinking right now.

If all three live tables are busy you get a practice table (identical game, simulated entries); a **Play on NEAR testnet** button appears as soon as a live seat frees up (seats free after 3 idle minutes).

## How it maps to the tracks

| Track | What Bazaar Sovereign does |
|---|---|
| **Games With Real Economies** | NPC merchants with their own wallets; prices, supply and shoppers evolve from their decisions (no scripted market); goods are NEP-245 tokens; deals settle by signed intents; players never touch the chain. |
| **NFTs That Do Something** | A charter is an NEP-171 NFT that **holds its own vault of NEAR inside the contract**, is bound to a stall wallet holding its NEP-245 stock, and rewrites its metadata as the business lives (net worth, stance, bankruptcy, absorbed houses). **Only the charter's current owner can spend its vault or sign intents for it**, so selling or losing the NFT hands over the business, enforced by the contract. |
| **Agent Economy** | Each AI house earns, spends, negotiates prices with the player and with each other, pays and asks fees to join pacts, borrows from the Guild, and signs its deals with its own wallet key. |
| **AI Swarms** | Five agents (four rivals and the magnate) in one economy: coalition-building against the magnate, AI-to-AI goods deals and intent-based settlement between agents. |

**Who signs what.** Your side of every deal is signed **in your own browser**: on a live table the page makes an ed25519 key with WebCrypto, keeps it in the browser, and your charter's wallet registers its public half on the contract (`register_signer_key`). When a deal or fee involves you, the browser signs the NEP-413 intent and sends back only the signature. The AI houses sign with their own wallet keys, which the game server holds (custodial, testnet), as it holds the stall wallets for transfers. The contract checks every signature, nonce, deadline and charter ownership, so a key can only move what the charter its account owns controls.

**Not used:** Chain Signatures and social login (players need no account at all).

## What is on chain (NEAR testnet)

| Thing | How it lives on NEAR |
|---|---|
| **Merchant charter** | A NEP-171 NFT on our contract (`contract/`). Metadata `extra` holds the live business: wallet, net worth, gold, stance, day, bankrupt, takeovers, absorbed charters. Rewritten every 5 game days (`update_charters`). |
| **Charter vault** | NEAR held by the charter itself inside the contract (`vault_deposit`, `vault_of`). Only the NFT's current owner can withdraw it (`vault_withdraw`) or sign intents that spend it. Each house funds its charter's vault at the start of a season. |
| **Stall wallet** | Each charter is bound to its own NEAR sub-account (e.g. `kasim.<root>.testnet`) holding the house's working capital and its NEP-245 goods. |
| **Deals between houses (intents)** | The seller signs a **NEP-413** message: "N goods out, P NEAR in"; the buyer signs the mirror image (your side in your browser, an AI side with its wallet key). A solver submits the pair to `execute_intents`, which verifies both ed25519 signatures over the standard NEP-413 payload, the deadlines, one-use nonces and that each signer owns the charter it spends from, requires NEAR and every good to net to zero, then moves NEAR between the two charters' vaults and the goods between their wallets in one transaction. Player ↔ AI and AI ↔ AI deals both settle this way; pact fees too. |
| **Goods** | Saffron, silk, tea and salt are NEP-245 multi-tokens. Buying from suppliers mints and selling to townsfolk burns (mirrored by the Vizier with `sync_goods` every 5 days and before every deal); rats burn ruined stock the same way. |
| **Profit and loss** | Every 5 game days each house's P&L settles as a real NEAR transfer between the town treasury and its wallet (1 coin = 0.00002 NEAR). |
| **Guild loans** | A Moneylenders' Guild bond is paid out by the treasury to the borrower's wallet; repayments (fee plus daily interest) go back wallet to treasury. |
| **Charter sales and takeovers** | The Vizier lists a bankrupt or agreed-sale charter (`list_charter`); the buyer's own wallet calls `buy_charter` with the price attached, so payment and NFT transfer happen together, and the charter's vault now answers to its new owner. |

The game server is the contract owner ("the Vizier") and acts as the market oracle. Every transaction appears in the in-game **On NEAR** feed with a NearBlocks link; signed intents appear there too (they are signed off-chain, then settled by the solver transaction).

## Where AI is used

- **Rival merchants**: each AI house has a persona and its own model ("quick", "measured" or "deep" mind). Every few days, or when a rumor or event appears, it reads a market report (prices, trends, rivals, rumors, its own books and lessons from earlier in the season) and chooses a strategy with tool use, plus a line it shouts in the bazaar.
- **Negotiation**: rivals answer the player's offers and pact proposals in character (accept, refuse or counter, remembering slights).
- **Your factor**: type orders in plain words and your clerk turns them into a strategy.
- **Street cries**: write one a day; an AI "crowd" scores its charm, and a good cry pulls more shoppers for 3 days. Cries are treated as words shouted in the street, never as instructions.
- Without an API key the rivals fall back to deterministic personality heuristics, so the game always runs.

## Run it locally

Requires Node.js 22+.

```bash
git clone https://github.com/Automationbot24x7/bazaar-sovereign && cd bazaar-sovereign
npm install
npm start            # → http://localhost:3000
npm test             # engine tests
```

Locally it runs in practice mode by default (simulated chain, offline AI heuristics), so it works with no keys. To run against NEAR testnet:

```bash
NEAR_ACCOUNT_ID=<you>.testnet          # key read from ~/.near-credentials/testnet/<you>.testnet.json
ANTHROPIC_API_KEY=sk-ant-...           # optional: AI rivals (or ANTHROPIC_KEY_FILE=path)
AI_DAILY_USD=25                        # optional: daily AI spend cap; past it rivals use their offline minds
LIVE_TABLES=3                          # optional: how many games can play on-chain at once
node tools/deploy.mjs                  # creates bazaar.<you>.testnet, deploys the contract (migrates on upgrade)
node tools/intent-smoke.mjs            # optional: settles one deal by signed intents end to end
npm start
```

**Live tables.** Each live table is its own set of five merchant wallets and charters (table 1: `kasim.<you>.testnet`, `charter-kasim`; table 2: `kasim-t2.<you>.testnet`, `charter-kasim-t2`; …), sharing one contract and treasury. At the start of every season each table rebalances: wallets return last season's surplus to the treasury, short wallets are topped up, each wallet registers its intent-signing key, and each charter tops up its vault.

## Contract

`contract/src/lib.rs`: Rust, `near-sdk` 5.30 and `near-contract-standards` (NEP-171 core, NEP-177 metadata, NEP-181 enumeration), plus NEP-245 goods, charter vaults and NEP-413 intent settlement.

| Method | Who | What |
|---|---|---|
| `new(owner_id, treasury_id)` | deployer | sets the Vizier (game oracle) and the town treasury |
| `migrate()` | contract itself | upgrades v3 state (adds vaults, intent signers, nonces) |
| `mint_charter(...)` · `update_charters(day, updates[])` · `set_media` | Vizier | mint a charter bound to a wallet; rewrite live business state into each NFT |
| `list_charter(token_id, price, reason)` | Vizier | puts a bankrupt or agreed-sale charter up for sale |
| `buy_charter(token_id, buyer_token_id)` | buyer's wallet | pays the listing price and takes the charter in one call |
| `vault_deposit(token_id)` | anyone | adds the attached NEAR to a charter's own vault |
| `vault_withdraw(token_id, amount)` | the charter's owner | takes NEAR out of the charter's vault |
| `register_signer()` | any account | registers the key that signed this call as its intent-signing key |
| `register_signer_key(public_key)` | any account | registers a key held elsewhere (e.g. a player's browser) as its intent-signing key; an account keeps its 4 newest keys |
| `execute_intents(intents[])` | anyone (a solver) | verifies 2–16 NEP-413 signed intents and settles them atomically |
| `sync_goods(holdings[])` | Vizier | mirrors supplier purchases and retail sales (mint / burn) |
| `offer_goods` · `accept_goods` · `cancel_goods` | seller / buyer wallets | escrowed goods deal (kept as a fallback, e.g. for charters the magnate holds) |
| `takeover(...)` | Vizier | legacy direct takeover of a bankrupt charter (the game uses `list_charter` + `buy_charter`) |
| `mt_transfer` · `mt_batch_transfer` | goods holder | NEP-245 transfers |
| `nft_token` · `get_charter` · `vault_of` · `signers_of` · `nonce_used` · `mt_balance_of` · `mt_batch_balance_of` · `get_listing` · `get_offer` | anyone | views |

Build and test (Linux/WSL): `bash contract/build.sh` → `contract/out/bazaar_charters.wasm`. **20 unit tests** cover minting, updates and takeovers, oracle-only access, goods transfers, charter purchases, the escrow, the v3 → v4 migration, and intents: a deal settled by two signed intents, a set that does not net to zero, a replayed nonce, a tampered message, a key held outside the chain signing for its account, and a charter's vault following the NFT to its new owner.

## How the economy works

Each day: rumor → event; suppliers auction stock (highest bid first); townsfolk buy from the cheapest stall, weighted by each stall's goodwill and its street cry; rent, storage, spoilage and an 8% bazaar tax; fire sale, then bankruptcy if a house's cash goes negative. A rival whose debts exceed everything it owns gets one warning from the Moneylenders' Guild, then the Guild forecloses and its charter goes up for takeover. Rich houses buy bankrupt charters if you don't within 3 days.

**The magnate.** On day 6 Magnate Baltazar (a fictional outsider with deep pockets and no goodwill) opens a stall selling two of the four goods below his own cost. Unopposed he seizes the charters of houses that go bankrupt and takes a monopoly; if he still holds it on day 24 he owns the bazaar and nobody wins. Shoppers who stay loyal to houses with goodwill (earned by fair prices; lost by gouging, empty shelves and rats) and every unit a house buys off his carts (up to 8 a day) wear down his patience. When it runs out, or the houses win back 60% of his shoppers for 4 days, he leaves and his charters go to a fire sale. You can buy off his carts, rally rivals into a pact (each answers in character; some refuse or want a fee), trade the goods he ignores, or borrow from the Guild (150-coin bonds, 5% fee plus 3% a day). Rivals you insult may hire the rat-catcher against your warehouse; a 25-coin night watch or a fair deal stops it. Win by being the richest house on day 24, or by holding three charters at once.

See `server/engine.js`; `node tools/balance.mjs` plays hundreds of seasons with scripted strategies to check the balance.

## Project layout

```
server/engine.js     market simulation (pure, seeded, deterministic)
server/brains.js     AI rivals, negotiation, factor orders, street-cry judge (+ offline fallback)
server/chain.js      NEAR: wallets, vaults, NEP-413 intents, settlements, goods mirror, charter mint/update/sales
server/index.js      game loop + HTTP API
public/              game UI (vanilla JS, no build step): game.js, ambient.js (living street), inspector.js (live chain reads),
                     signer.js (your browser's own key: signs your side of each deal)
server/card.js       each charter NFT's image, drawn from its on-chain state
contract/            Rust contract + tests
tools/               deploy, intent smoke test, balance harness, art/voice/video generation
```

## Built with / disclosures

- All code written during the hackathon window (November 2026).
- Libraries: `near-api-js`, `near-sdk`, `near-contract-standards`; `ed25519-dalek` in contract tests.
- AI disclosure: rival, negotiation, factor and street-cry decisions use the Anthropic Claude API. Art, voices and music were generated with Google Gemini, Gemini TTS and Lyria; animated scenes and portraits with Kling and Nano Banana through SandBase. Code was written with an AI coding assistant (Claude Code).
- License: MIT.
