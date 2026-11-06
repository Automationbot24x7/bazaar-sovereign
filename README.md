# Bazaar Sovereign

**A living bazaar where every merchant is an NFT that owns its own NEAR wallet — and AI minds run your rivals.**

Built for NEAR HACKATHON 2026 · tracks: **Games With Real Economies**, **NFTs That Do Something**.

You inherit a merchant charter in a desert bazaar. Four rival merchants — each its own AI personality — trade saffron, silk, tea and salt against you. Rumors warn of droughts, caravans and festivals; corner a market before it moves, undercut, hoard, or go premium. Merchants who run out of gold go bankrupt, and their **charter NFT can be bought — taking over the whole business: its wallet, its stock, its history.**

Players never see a wallet popup. The chain is underneath the game loop, not in front of it.

## What is on-chain (NEAR testnet)

| Thing | How it lives on NEAR |
|---|---|
| **Merchant charter** | A NEP-171 NFT on our contract (`contract/`). Metadata `extra` holds the live business: wallet, net worth, gold, stance, day, bankrupt, takeovers, absorbed charters. |
| **Merchant wallet** | Each charter has its own NEAR sub-account (e.g. `kasim.<vizier>.testnet`) funded with working capital — *the NFT owns money*. |
| **Profit & loss** | Every 5 game days, each merchant's P&L settles as a real NEAR transfer between the town treasury and the merchant's wallet (1 coin = 0.00002 NEAR). |
| **Guild loans** | A Moneylenders' Guild bond is paid out by the town treasury to the borrower's wallet; the repayment, with its fee and daily interest, goes back wallet-to-treasury. |
| **Rats** | When a rival's rats ruin stock in a warehouse, the Vizier burns those goods tokens from the wallet. |
| **Dynamic NFT** | `update_charters` rewrites every charter's metadata with that day's net worth / stance / bankruptcy, emitting `EVENT_JSON` logs. |
| **Goods** | Saffron, silk, tea and salt are NEP-245 multi-tokens held by the merchant wallets; the Vizier mirrors market buying and selling with `sync_goods`. |
| **Deals between houses** | Atomic, through the contract's escrow: the seller's wallet locks the goods for one named buyer at a fixed price (`offer_goods`), then the buyer's wallet attaches the NEAR and receives the goods in the same transaction (`accept_goods`). Neither side can be left holding only half a deal. |
| **Charter sales & takeovers** | The Vizier lists a distressed or agreed-sale charter (`list_charter`); the buyer's own wallet calls `buy_charter` with the price attached, so payment and NFT transfer happen together. The buyer's charter records the absorption. |

The game server is the contract owner ("the Vizier") and acts as oracle. Every transaction appears in the in-game **On-chain** feed with a NearBlocks link.

## Where AI is used

- **Rival merchants** — each NPC has a persona and, every few days or when a rumor/event appears, reads a market report (prices, trends, rivals, rumors, its own books) and chooses a doctrine (`steady / undercut / corner / hoard / premium / liquidate`, focus good, aggression) via tool use, plus a line of dialogue shown in the bazaar.
- **Your factor** — type orders in plain English ("Drought is coming — corner the saffron") and your head clerk turns them into a doctrine and replies in character.
- **Art**: all portraits, goods and the bazaar backdrop, generated once by `tools/gen-art.mjs`.
- **Voices and music**: the short story scenes at the big moments (skippable) are voiced and scored with generated speech and three music tracks, made once by `tools/gen-audio.mjs` and shipped as files, so playing costs nothing. Total generation cost: about $0.30.
- Without an API key the NPCs fall back to a deterministic personality heuristic, so the game always runs.

## Try it (judges: ~2 minutes)

Requires Node.js 22+.

```bash
git clone https://github.com/Automationbot24x7/bazaar-sovereign && cd bazaar-sovereign
npm install
npm start            # → http://localhost:3000
```

Then:

1. **Click "Enter the bazaar"** → you see five stalls (yours is gold-outlined), a market board and an empty on-chain feed.
2. **Click "▶ Open the bazaar"** → days advance; prices move; rivals start talking in speech bubbles.
3. **Wait for a "Rumor:" banner** (or click **⏩ 30 days**) → type an order like *"Drought is coming — corner the saffron"* → your factor replies and your stance badge changes to `CORNER · saffron`.
4. **Watch the Saffron card** → the ownership bar fills with your colour; the price climbs once the drought hits.
5. **When a rival goes bankrupt** (greyed out, torn charter) → click **Buy charter** → their stock moves into your stall and the feed shows the `takeover` transaction.
6. **On-chain feed** → every 5 days: `settle` and `update` entries (testnet mode links to NearBlocks).

Runs fully offline in **mock chain** mode by default. To run against **NEAR testnet**, set:

```bash
NEAR_ACCOUNT_ID=<you>.testnet          # key read from ~/.near-credentials/testnet/<you>.testnet.json
ANTHROPIC_API_KEY=sk-ant-...           # optional: AI rivals (or ANTHROPIC_KEY_FILE=path)
AI_DAILY_USD=25                        # optional: daily AI spend cap; past it rivals use their offline minds
LIVE_TABLES=3                          # optional: how many games can play on-chain at once (default 3)
node tools/deploy.mjs                  # one-time: creates bazaar.<you>.testnet and deploys the contract
npm start
```

**Live tables.** Each live table is its own set of five merchant wallets and charters (table 1: `kasim.<you>.testnet`, `charter-kasim`; table 2: `kasim-t2.<you>.testnet`, `charter-kasim-t2`; …), sharing one contract and treasury. A new visitor takes a free table; when all are seated they play an identical practice table with simulated entries, and move up to a live table on their next new season once one frees. A seat is released after 5 idle minutes. At the start of every season the table rebalances on-chain: each wallet returns last season's surplus to the treasury, and the treasury tops short wallets up to the same working capital.

## Live

Play at **https://bazaar.reconscribe.com**. It runs as an always-on Node.js worker on the owner's existing web hosting (its own website, separate from reconscribe.com). Update it with `bash tools/deploy-host.sh` (uploads over SSH; the host restarts the server). Keys live in a private `.env` on the server, never in the repo.

## Contract

`contract/src/lib.rs` — Rust, `near-sdk` 5.30 + `near-contract-standards` (NEP-171 core, NEP-177 metadata, NEP-181 enumeration) plus NEP-245 goods.

| Method | Who | What |
|---|---|---|
| `new(owner_id, treasury_id)` | deployer | sets the Vizier (game oracle) and the town treasury |
| `migrate()` | contract itself | one-time upgrade of v2 state (adds the escrow) |
| `mint_charter(token_id, owner_id, name, wallet, persona, media)` | Vizier | mints a charter bound to a merchant wallet |
| `update_charters(day, updates[])` | Vizier | batch-writes live business state into each NFT |
| `list_charter(token_id, price, reason)` | Vizier | puts a charter up for sale |
| `buy_charter(token_id, buyer_token_id)` | buyer's wallet | pays the listing price and takes the charter in one call |
| `takeover(token_id, new_owner_id, price_gold, buyer_token_id)` | Vizier | moves a **bankrupt** charter to the buyer, records the absorption |
| `sync_goods(holdings[])` | Vizier | mirrors market purchases and sales into goods balances |
| `offer_goods(offer_id, buyer_id, token_id, amount, price)` | seller's wallet | locks goods in escrow for one buyer at a fixed price |
| `accept_goods(offer_id)` | buyer's wallet | pays the price; goods to the buyer and NEAR to the seller, atomically |
| `cancel_goods(offer_id)` | seller's wallet | takes back goods from an offer nobody accepted |
| `mt_transfer` · `mt_batch_transfer` | goods holder | NEP-245 transfers |
| `get_charter` · `get_listing` · `get_offer` · `mt_balance_of` · `mt_supply` · `nft_token` · `nft_tokens` · `nft_metadata` | anyone | views |

Build & test (Linux/WSL): `bash contract/build.sh` → `contract/out/bazaar_charters.wasm`. Twelve unit tests cover minting, updates and takeovers, oracle-only access, wallet-signed goods transfers, charter purchases, the escrow (atomic deal, wrong buyer, underpayment, cancel) and the v2 → v3 migration. Deploy or upgrade with `node --env-file=.env tools/deploy.mjs`.

## How the economy works

**Mid-season threats.** On day 6 the Magnate Baltazar (a fictional outsider with deep pockets and no goodwill) opens a stall selling two of the four goods below his own cost. Losing money to shoppers is his plan. Unopposed he grows louder, seizes the charters of houses that go bankrupt, and takes a monopoly; if he still holds it on day 24 he owns the bazaar and nobody wins. What wears down his patience: shoppers who stay loyal to houses with goodwill (earned by fair prices; lost by gouging, empty shelves and rats) and every unit a house buys off his carts (8 a day, delivered overnight). When his patience runs out, or the houses win back 60% of his shoppers for 4 days, he leaves and his charters go to a fire sale. You can buy off his carts, rally rivals into a pact (each answers in character; some refuse or want a fee), trade the goods he ignores, or borrow from the Moneylenders' Guild to outlast him (150-coin bonds, 5% fee plus 3% a day; debt counts against net worth). Rivals you have insulted may hire the rat-catcher against your warehouse; the rumor comes a day early, and a 25-coin night watch or a fair deal stops it.


Each day: rumor → event; suppliers auction stock (highest bid first, reserve price); townsfolk buy from the cheapest stall (with a slice of loyal regulars per stall); rent, storage, spoilage and an 8% bazaar tax; fire-sale then bankruptcy if gold < 0. Rich NPCs buy bankrupt charters if you don't within 3 days. See `server/engine.js`.

## Project layout

```
server/engine.js   market simulation (pure, seeded, deterministic)
server/brains.js   rival merchant brains + player order parser (+ offline fallback)
server/chain.js    NEAR: sub-account wallets, settlements, goods mirror, escrowed deals, charter mint/update/sales
server/index.js    game loop + HTTP API
public/            game UI (vanilla JS, no build step)
contract/          Rust NEP-171 charter contract + tests
tools/             deploy.mjs (testnet), gen-art.mjs (art), gen-audio.mjs (voices + music)
```

## Built with / disclosures

- Code written during the hackathon window (Nov 2026). No pre-hackathon code.
- Libraries: `near-api-js`, `near-sdk`, `near-contract-standards`.
- AI disclosure: rival and factor decisions use the Anthropic Claude API; art, voices and music were generated with Google Gemini, Gemini TTS and Lyria; code was written with an AI coding assistant (Claude Code).
- License: MIT.
