//! Bazaar Sovereign — merchant charters.
//!
//! Every merchant in the game is a NEP-171 NFT ("charter"). The charter's metadata
//! points at the merchant's own NEAR wallet (a sub-account that holds its working
//! capital) and is rewritten as the business lives: net worth, gold, trading stance,
//! bankruptcy. When a merchant goes bankrupt its charter can be taken over — the NFT
//! moves to the buyer and the whole business (wallet, stock, debts) goes with it.
//!
//! Goods (saffron, silk, tea, salt) are NEP-245 multi-tokens held by merchant wallets.
//! Merchants trade goods between themselves through escrow: the seller's wallet locks
//! goods for a named buyer at a fixed price (`offer_goods`) and the buyer's wallet pays
//! and receives them in one transaction (`accept_goods`). Plain `mt_transfer` also works.
//! The Vizier only mirrors market activity with suppliers and townsfolk
//! (`sync_goods`: mint on wholesale purchase, burn on retail sale).
//!
//! The game server is the contract owner ("the Vizier"): it mints charters, writes
//! daily state, and lists distressed or agreed-sale charters. A listed charter is
//! bought by the *buyer's own wallet* with `buy_charter`, attaching the price in NEAR:
//! payment to the treasury and NFT transfer happen in one transaction.

use near_contract_standards::non_fungible_token::core::{NonFungibleTokenCore, NonFungibleTokenResolver};
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::{NonFungibleToken, Token, TokenId};
use near_sdk::collections::LazyOption;
use near_sdk::borsh::BorshSerialize;
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{self, json};
use near_sdk::store::LookupMap;
use near_sdk::{assert_one_yocto, env, near, require, AccountId, BorshStorageKey, CurveType, NearSchema, NearToken, PanicOnDefault, Promise, PromiseOrValue, PublicKey};
use std::collections::HashMap;
use std::str::FromStr;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    NonFungibleToken,
    Metadata,
    TokenMetadata,
    Enumeration,
    Approval,
    Charters,
    Goods,
    GoodsSupply,
    Listings,
    Offers,
    Vaults,
    Signers,
    Nonces,
}

pub const GOODS: [&str; 4] = ["saffron", "silk", "tea", "salt"];

#[derive(Serialize, Deserialize, NearSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct GoodsHolding {
    pub account_id: AccountId,
    pub token_id: String,
    pub amount: U128,
}

/// Live state of a merchant business, mirrored into the NFT's `extra` field.
#[derive(Clone, Debug, PartialEq)]
#[near(serializers = [borsh, json])]
pub struct Charter {
    pub name: String,
    pub wallet: AccountId,
    pub persona: String,
    pub net_worth: i64,
    pub gold: i64,
    pub stance: String,
    pub day: u32,
    pub bankrupt: bool,
    pub takeovers: u32,
    /// Charter ids this merchant has absorbed via takeover.
    pub absorbed: Vec<TokenId>,
}

#[derive(Serialize, Deserialize, NearSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct CharterUpdate {
    pub token_id: TokenId,
    pub net_worth: i64,
    pub gold: i64,
    pub stance: String,
    pub bankrupt: bool,
}

/// Goods locked in escrow by a seller for one named buyer at a fixed price.
#[derive(Clone)]
#[near(serializers = [borsh, json])]
pub struct GoodsOffer {
    pub seller: AccountId,
    pub buyer: AccountId,
    pub token_id: String,
    pub amount: U128,
    pub price: U128,
}

/// What one party commits to in a deal, signed by the account that owns the charter it spends from.
/// `near` is a signed yoctoNEAR amount for the charter's vault; `goods` are signed quantities for the
/// charter wallet's NEP-245 balances. A set of intents settles only if every asset nets to zero.
#[derive(Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct IntentPayload {
    pub signer_id: AccountId,
    pub charter: TokenId,
    pub deadline_ms: u64,
    pub near: String,
    #[serde(default)]
    pub goods: HashMap<String, i64>,
    #[serde(default)]
    pub memo: Option<String>,
}

/// A NEP-413 signed message (the standard NEAR wallets use for off-chain signing, and the one NEAR Intents
/// uses): `message` is the intent JSON, `nonce` 32 random bytes (one use per signer), `recipient` this
/// contract. The 64-byte ed25519 `signature` covers sha256(borsh(2^31 + 413) ++ borsh(payload)).
#[derive(Serialize, Deserialize, NearSchema, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct SignedIntent {
    pub message: String,
    pub nonce: Vec<u8>,
    pub recipient: String,
    pub public_key: String,
    pub signature: Vec<u8>,
}

/// NEP-413 payload, borsh-serialized after the tag for signing.
#[derive(BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
struct Nep413Payload {
    message: String,
    nonce: [u8; 32],
    recipient: String,
    callback_url: Option<String>,
}
const NEP413_TAG: u32 = 2_147_484_061; // 2^31 + 413

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Contract {
    tokens: NonFungibleToken,
    metadata: LazyOption<NFTContractMetadata>,
    charters: LookupMap<TokenId, Charter>,
    day: u32,
    treasury: AccountId,
    /// NEP-245 balances, key = "<good>|<account>"
    goods: LookupMap<String, u128>,
    goods_supply: LookupMap<String, u128>,
    /// charter token_id -> price in yoctoNEAR
    listings: LookupMap<TokenId, u128>,
    /// open escrowed goods offers by id
    offers: LookupMap<String, GoodsOffer>,
    /// NEAR held by each charter itself (yoctoNEAR): the NFT owns money; whoever owns the NFT controls it
    vaults: LookupMap<TokenId, u128>,
    /// ed25519 keys an account registered for signing intents ("ed25519:<base58>")
    signers: LookupMap<AccountId, Vec<String>>,
    /// used intent nonces, key = "<signer>|<nonce>"
    nonces: LookupMap<String, bool>,
}

/// State layout of v3 (escrow, before charter vaults and intents), read once by `migrate`.
#[near(serializers = [borsh])]
struct ContractV3 {
    tokens: NonFungibleToken,
    metadata: LazyOption<NFTContractMetadata>,
    charters: LookupMap<TokenId, Charter>,
    day: u32,
    treasury: AccountId,
    goods: LookupMap<String, u128>,
    goods_supply: LookupMap<String, u128>,
    listings: LookupMap<TokenId, u128>,
    offers: LookupMap<String, GoodsOffer>,
}

fn mt_event(kind: &str, data: serde_json::Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": "nep245", "version": "1.0.0", "event": kind, "data": [data] })));
}

fn gkey(good: &str, account: &AccountId) -> String {
    format!("{}|{}", good, account)
}

fn assert_good(good: &str) {
    require!(GOODS.contains(&good), "Unknown good");
}

fn event(kind: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "bazaar_sovereign", "version": "1.0.0", "event": kind, "data": [data] })
    ));
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId, treasury_id: AccountId) -> Self {
        let metadata = NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "Bazaar Sovereign Charters".to_string(),
            symbol: "CHARTER".to_string(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        };
        Self {
            tokens: NonFungibleToken::new(
                StorageKey::NonFungibleToken,
                owner_id,
                Some(StorageKey::TokenMetadata),
                Some(StorageKey::Enumeration),
                Some(StorageKey::Approval),
            ),
            metadata: LazyOption::new(StorageKey::Metadata, Some(&metadata)),
            charters: LookupMap::new(StorageKey::Charters),
            day: 0,
            treasury: treasury_id,
            goods: LookupMap::new(StorageKey::Goods),
            goods_supply: LookupMap::new(StorageKey::GoodsSupply),
            listings: LookupMap::new(StorageKey::Listings),
            offers: LookupMap::new(StorageKey::Offers),
            vaults: LookupMap::new(StorageKey::Vaults),
            signers: LookupMap::new(StorageKey::Signers),
            nonces: LookupMap::new(StorageKey::Nonces),
        }
    }

    /// One-time upgrade from v3 state: keeps every charter, balance, listing and offer and adds
    /// charter vaults, intent signers and nonces.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: ContractV3 = env::state_read().expect("No v3 state to migrate");
        Self {
            tokens: old.tokens,
            metadata: old.metadata,
            charters: old.charters,
            day: old.day,
            treasury: old.treasury,
            goods: old.goods,
            goods_supply: old.goods_supply,
            listings: old.listings,
            offers: old.offers,
            vaults: LookupMap::new(StorageKey::Vaults),
            signers: LookupMap::new(StorageKey::Signers),
            nonces: LookupMap::new(StorageKey::Nonces),
        }
    }

    fn assert_vizier(&self) {
        require!(env::predecessor_account_id() == self.tokens.owner_id, "Only the Vizier (game oracle) can do this");
    }

    /// Vizier: point a charter's image at a new URL (the game moved host).
    pub fn set_media(&mut self, token_id: TokenId, media: String) {
        self.assert_vizier();
        let metas = self.tokens.token_metadata_by_id.as_mut().expect("No metadata");
        let mut meta = metas.get(&token_id).expect("No such charter");
        meta.media = Some(media);
        metas.insert(&token_id, &meta);
    }

    fn write_metadata(&mut self, token_id: &TokenId, c: &Charter) {
        let status = if c.bankrupt { "BANKRUPT" } else { "trading" };
        let meta = TokenMetadata {
            title: Some(format!("{} — merchant charter", c.name)),
            description: Some(format!(
                "Day {} · net worth {}g · {} · stance: {} · wallet {}",
                c.day, c.net_worth, status, c.stance, c.wallet
            )),
            media: self
                .tokens
                .token_metadata_by_id
                .as_ref()
                .and_then(|m| m.get(token_id))
                .and_then(|m| m.media),
            media_hash: None,
            copies: Some(1),
            issued_at: None,
            expires_at: None,
            starts_at: None,
            updated_at: Some(env::block_timestamp_ms().to_string()),
            extra: Some(serde_json::to_string(c).unwrap()),
            reference: None,
            reference_hash: None,
        };
        self.tokens.token_metadata_by_id.as_mut().unwrap().insert(token_id, &meta);
    }

    /// Mint a merchant charter. The merchant's wallet is a separate NEAR account
    /// (normally `<slug>.<vizier>`) that holds the business's working capital.
    #[payable]
    pub fn mint_charter(
        &mut self,
        token_id: TokenId,
        owner_id: AccountId,
        name: String,
        wallet: AccountId,
        persona: String,
        media: Option<String>,
    ) -> Token {
        self.assert_vizier();
        let charter = Charter {
            name: name.clone(),
            wallet: wallet.clone(),
            persona,
            net_worth: 300,
            gold: 300,
            stance: "steady".to_string(),
            day: self.day,
            bankrupt: false,
            takeovers: 0,
            absorbed: vec![],
        };
        let meta = TokenMetadata {
            title: Some(format!("{} — merchant charter", name)),
            description: Some(format!("A new stall opens in the bazaar. Wallet {}", wallet)),
            media,
            media_hash: None,
            copies: Some(1),
            issued_at: Some(env::block_timestamp_ms().to_string()),
            expires_at: None,
            starts_at: None,
            updated_at: None,
            extra: Some(serde_json::to_string(&charter).unwrap()),
            reference: None,
            reference_hash: None,
        };
        let token = self.tokens.internal_mint(token_id.clone(), owner_id.clone(), Some(meta));
        self.charters.insert(token_id.clone(), charter);
        event("charter_minted", json!({ "token_id": token_id, "owner_id": owner_id, "wallet": wallet, "name": name }));
        token
    }

    /// Daily (batched) state sync from the game: the NFT is a living record of the business.
    pub fn update_charters(&mut self, day: u32, updates: Vec<CharterUpdate>) {
        self.assert_vizier();
        self.day = day;
        for u in updates {
            let Some(mut c) = self.charters.get(&u.token_id).cloned() else { continue };
            let newly_bankrupt = u.bankrupt && !c.bankrupt;
            c.net_worth = u.net_worth;
            c.gold = u.gold;
            c.stance = u.stance;
            c.bankrupt = u.bankrupt;
            c.day = day;
            self.write_metadata(&u.token_id, &c);
            self.charters.insert(u.token_id.clone(), c.clone());
            if newly_bankrupt {
                event("charter_bankrupt", json!({ "token_id": u.token_id, "day": day, "name": c.name }));
            }
        }
        event("charters_updated", json!({ "day": day }));
    }

    /// A bankrupt charter is bought: the NFT moves to the buyer's owner account and is
    /// recorded as absorbed by the buyer's charter. Payment for the charter is settled
    /// wallet-to-wallet by the game in a separate NEAR transfer.
    #[payable]
    pub fn takeover(&mut self, token_id: TokenId, new_owner_id: AccountId, price_gold: u64, buyer_token_id: TokenId) {
        self.assert_vizier();
        let target = self.charters.get(&token_id).cloned().expect("Unknown charter");
        require!(target.bankrupt, "Only bankrupt charters can be taken over");
        let owner = self.tokens.owner_by_id.get(&token_id).expect("No owner");
        if owner != new_owner_id {
            self.tokens.internal_transfer(&owner, &new_owner_id, &token_id, None, Some(format!("Takeover for {}g", price_gold)));
        }
        if let Some(mut buyer) = self.charters.get(&buyer_token_id).cloned() {
            buyer.takeovers += 1;
            buyer.absorbed.push(token_id.clone());
            self.write_metadata(&buyer_token_id, &buyer);
            self.charters.insert(buyer_token_id.clone(), buyer);
        }
        event(
            "charter_takeover",
            json!({ "token_id": token_id, "from": owner, "to": new_owner_id, "price_gold": price_gold, "buyer_token_id": buyer_token_id }),
        );
    }

    // ---------- charter sales: listed by the Vizier, bought by the buyer's wallet ----------

    /// List a charter for sale (a bankruptcy seizure, or a buyout the owner agreed to).
    pub fn list_charter(&mut self, token_id: TokenId, price: U128, reason: String) {
        self.assert_vizier();
        require!(self.charters.get(&token_id).is_some(), "Unknown charter");
        self.listings.insert(token_id.clone(), price.0);
        event("charter_listed", json!({ "token_id": token_id, "price": price, "reason": reason }));
    }

    /// Buy a listed charter. The caller (the buyer's merchant wallet) attaches the price;
    /// the NEAR goes to the treasury and the NFT moves to the caller in the same transaction.
    #[payable]
    pub fn buy_charter(&mut self, token_id: TokenId, buyer_token_id: Option<TokenId>) {
        let price = self.listings.get(&token_id).copied().expect("Charter is not for sale");
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= price, "Attached deposit is below the listing price");
        let buyer = env::predecessor_account_id();
        let owner = self.tokens.owner_by_id.get(&token_id).expect("No owner");
        require!(owner != buyer, "You already own this charter");
        self.tokens.internal_transfer(&owner, &buyer, &token_id, None, Some("Charter bought".to_string()));
        self.listings.remove(&token_id);
        if let Some(bt) = buyer_token_id.clone() {
            if let Some(mut b) = self.charters.get(&bt).cloned() {
                b.takeovers += 1;
                b.absorbed.push(token_id.clone());
                self.write_metadata(&bt, &b);
                self.charters.insert(bt, b);
            }
        }
        Promise::new(self.treasury.clone()).transfer(NearToken::from_yoctonear(deposit)).detach();
        event("charter_sold", json!({ "token_id": token_id, "from": owner, "to": buyer, "price": U128(deposit), "buyer_token_id": buyer_token_id }));
    }

    pub fn get_listing(&self, token_id: TokenId) -> Option<U128> {
        self.listings.get(&token_id).map(|p| U128(*p))
    }

    pub fn get_treasury(&self) -> AccountId {
        self.treasury.clone()
    }

    // ---------- atomic goods deals via escrow ----------

    /// Seller's wallet locks goods in escrow for a named buyer at a fixed total price (yoctoNEAR).
    #[payable]
    pub fn offer_goods(&mut self, offer_id: String, buyer_id: AccountId, token_id: String, amount: U128, price: U128) {
        assert_one_yocto();
        require!(self.offers.get(&offer_id).is_none(), "Offer id already used");
        let seller = env::predecessor_account_id();
        let escrow = env::current_account_id();
        self.internal_mt_transfer(&seller, &escrow, &token_id, amount.0);
        self.offers.insert(offer_id.clone(), GoodsOffer { seller: seller.clone(), buyer: buyer_id.clone(), token_id: token_id.clone(), amount, price });
        event("goods_offered", json!({ "offer_id": offer_id, "seller": seller, "buyer": buyer_id, "token_id": token_id, "amount": amount, "price": price }));
    }

    /// Buyer's wallet pays the exact price: goods go to the buyer and NEAR to the seller, atomically.
    #[payable]
    pub fn accept_goods(&mut self, offer_id: String) {
        let o = self.offers.get(&offer_id).cloned().expect("No such offer");
        let buyer = env::predecessor_account_id();
        require!(buyer == o.buyer, "This offer is for another buyer");
        require!(env::attached_deposit().as_yoctonear() >= o.price.0, "Attached deposit is below the price");
        let escrow = env::current_account_id();
        self.internal_mt_transfer(&escrow, &buyer, &o.token_id, o.amount.0);
        self.offers.remove(&offer_id);
        Promise::new(o.seller.clone()).transfer(env::attached_deposit()).detach();
        mt_event("mt_transfer", json!({ "old_owner_id": o.seller, "new_owner_id": buyer, "token_ids": [o.token_id], "amounts": [o.amount], "memo": format!("deal {}", offer_id) }));
        event("goods_sold", json!({ "offer_id": offer_id, "seller": o.seller, "buyer": buyer, "price": o.price }));
    }

    /// Seller reclaims goods from an offer nobody accepted.
    #[payable]
    pub fn cancel_goods(&mut self, offer_id: String) {
        assert_one_yocto();
        let o = self.offers.get(&offer_id).cloned().expect("No such offer");
        require!(env::predecessor_account_id() == o.seller, "Only the seller can cancel");
        let escrow = env::current_account_id();
        self.internal_mt_transfer(&escrow, &o.seller, &o.token_id, o.amount.0);
        self.offers.remove(&offer_id);
        event("goods_offer_cancelled", json!({ "offer_id": offer_id }));
    }

    pub fn get_offer(&self, offer_id: String) -> Option<GoodsOffer> {
        self.offers.get(&offer_id).cloned()
    }

    // ---------- charter vaults: the NFT itself holds money ----------

    /// Anyone can put NEAR into a charter's vault (a merchant funding its own business, a patron, a solver).
    #[payable]
    pub fn vault_deposit(&mut self, token_id: TokenId) {
        require!(self.charters.get(&token_id).is_some(), "Unknown charter");
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "Attach NEAR to deposit");
        let v = self.vaults.get(&token_id).copied().unwrap_or(0);
        self.vaults.insert(token_id.clone(), v + amount);
        event("vault_deposit", json!({ "token_id": token_id, "from": env::predecessor_account_id(), "amount": U128(amount) }));
    }

    /// Only the charter's current owner can take NEAR out of its vault. Sell or lose the NFT and you lose the money.
    pub fn vault_withdraw(&mut self, token_id: TokenId, amount: U128) -> Promise {
        let owner = self.tokens.owner_by_id.get(&token_id).expect("Unknown charter");
        require!(env::predecessor_account_id() == owner, "Only the charter's owner can withdraw from its vault");
        let v = self.vaults.get(&token_id).copied().unwrap_or(0);
        require!(v >= amount.0, "The vault holds less than that");
        self.vaults.insert(token_id.clone(), v - amount.0);
        event("vault_withdraw", json!({ "token_id": token_id, "to": owner, "amount": amount }));
        Promise::new(owner).transfer(NearToken::from_yoctonear(amount.0))
    }

    pub fn vault_of(&self, token_id: TokenId) -> U128 {
        U128(self.vaults.get(&token_id).copied().unwrap_or(0))
    }

    // ---------- intent-based settlement ----------

    /// The calling account registers the access key that signed this transaction as an intent-signing key.
    /// Calling with the key itself proves the account controls it.
    pub fn register_signer(&mut self) {
        let account = env::predecessor_account_id();
        require!(account == env::signer_account_id(), "Call this directly from the account");
        let pk = String::from(&env::signer_account_pk());
        let mut keys = self.signers.get(&account).cloned().unwrap_or_default();
        if !keys.contains(&pk) {
            require!(keys.len() < 4, "At most 4 signing keys");
            keys.push(pk.clone());
            self.signers.insert(account.clone(), keys);
            event("signer_registered", json!({ "account_id": account, "public_key": pk }));
        }
    }

    pub fn signers_of(&self, account_id: AccountId) -> Vec<String> {
        self.signers.get(&account_id).cloned().unwrap_or_default()
    }

    pub fn nonce_used(&self, signer_id: AccountId, nonce: String) -> bool {
        self.nonces.get(&format!("{}|{}", signer_id, nonce)).is_some()
    }

    /// Checks one NEP-413 signed intent and returns it with its nonce (hex).
    fn verify_intent(&self, si: &SignedIntent) -> (IntentPayload, String) {
        require!(si.recipient == env::current_account_id().to_string(), "Intent is addressed to another contract");
        let nonce: [u8; 32] = si.nonce.as_slice().try_into().unwrap_or_else(|_| env::panic_str("Nonce must be 32 bytes"));
        let p: IntentPayload = serde_json::from_str(&si.message).unwrap_or_else(|_| env::panic_str("Intent message is not valid JSON"));
        let keys = self.signers.get(&p.signer_id).cloned().unwrap_or_default();
        require!(keys.contains(&si.public_key), "Key is not registered for this signer");
        let pk = PublicKey::from_str(&si.public_key).unwrap_or_else(|_| env::panic_str("Bad public key"));
        require!(pk.curve_type() == CurveType::ED25519, "Only ed25519 keys");
        let pk_bytes: [u8; 32] = pk.as_bytes()[1..].try_into().unwrap_or_else(|_| env::panic_str("Bad public key"));
        let sig: [u8; 64] = si.signature.as_slice().try_into().unwrap_or_else(|_| env::panic_str("Signature must be 64 bytes"));
        let mut bytes = near_sdk::borsh::to_vec(&NEP413_TAG).unwrap();
        bytes.extend(near_sdk::borsh::to_vec(&Nep413Payload { message: si.message.clone(), nonce, recipient: si.recipient.clone(), callback_url: None }).unwrap());
        require!(env::ed25519_verify(&sig, &env::sha256(&bytes), &pk_bytes), "Bad intent signature");
        require!(p.deadline_ms >= env::block_timestamp_ms(), "Intent expired");
        let n = hex(&nonce);
        require!(self.nonces.get(&format!("{}|{}", p.signer_id, n)).is_none(), "Intent nonce already used");
        let owner = self.tokens.owner_by_id.get(&p.charter).expect("Unknown charter");
        require!(owner == p.signer_id, "Signer does not own this charter");
        (p, n)
    }

    /// Settles a matched set of signed intents in one transaction. Callable by anyone (a "solver"):
    /// every signature, deadline, nonce and charter ownership is checked; NEAR and every good must net
    /// to zero across the set; then each charter's vault and its wallet's goods move by the signed amounts.
    pub fn execute_intents(&mut self, intents: Vec<SignedIntent>) {
        require!(intents.len() >= 2 && intents.len() <= 16, "Settle between 2 and 16 intents");
        let checked: Vec<(IntentPayload, String)> = intents.iter().map(|si| self.verify_intent(si)).collect();
        let mut near_sum: i128 = 0;
        let mut goods_sum: HashMap<String, i128> = HashMap::new();
        let mut seen: Vec<String> = vec![];
        for (p, nonce) in &checked {
            let n = format!("{}|{}", p.signer_id, nonce);
            require!(!seen.contains(&n), "The same intent twice");
            seen.push(n);
            near_sum += p.near.parse::<i128>().unwrap_or_else(|_| env::panic_str("Bad NEAR amount"));
            for (g, q) in &p.goods {
                assert_good(g);
                *goods_sum.entry(g.clone()).or_insert(0) += *q as i128;
            }
        }
        require!(near_sum == 0, "NEAR does not net to zero across the intents");
        require!(goods_sum.values().all(|v| *v == 0), "Goods do not net to zero across the intents");
        let mut legs = vec![];
        for (p, nonce) in &checked {
            self.nonces.insert(format!("{}|{}", p.signer_id, nonce), true);
            let dn = p.near.parse::<i128>().unwrap();
            let v = self.vaults.get(&p.charter).copied().unwrap_or(0) as i128 + dn;
            require!(v >= 0, "A charter's vault cannot go below zero");
            self.vaults.insert(p.charter.clone(), v as u128);
            let wallet = self.charters.get(&p.charter).expect("Unknown charter").wallet.clone();
            for (g, q) in &p.goods {
                let key = gkey(g, &wallet);
                let b = self.goods.get(&key).copied().unwrap_or(0) as i128 + *q as i128;
                require!(b >= 0, "Not enough goods in the charter's wallet");
                if b == 0 {
                    self.goods.remove(&key);
                } else {
                    self.goods.insert(key, b as u128);
                }
            }
            legs.push(json!({ "signer": p.signer_id, "charter": p.charter, "near": p.near, "goods": p.goods, "memo": p.memo }));
        }
        // NEP-245 transfer logs for two-party goods legs, so indexers see the goods move
        let parsed: Vec<&IntentPayload> = checked.iter().map(|(p, _)| p).collect();
        if parsed.len() == 2 {
            for (g, q) in &parsed[0].goods {
                if *q == 0 {
                    continue;
                }
                let (from, to) = if *q < 0 { (parsed[0], parsed[1]) } else { (parsed[1], parsed[0]) };
                let fw = self.charters.get(&from.charter).unwrap().wallet.clone();
                let tw = self.charters.get(&to.charter).unwrap().wallet.clone();
                mt_event("mt_transfer", json!({ "old_owner_id": fw, "new_owner_id": tw, "token_ids": [g], "amounts": [U128(q.unsigned_abs() as u128)], "memo": "intent settlement" }));
            }
        }
        event("intents_settled", json!({ "solver": env::predecessor_account_id(), "legs": legs }));
    }

    // ---------- NEP-245 goods ----------

    fn set_balance(&mut self, good: &str, account: &AccountId, amount: u128) {
        let key = gkey(good, account);
        let old = self.goods.get(&key).copied().unwrap_or(0);
        if old == amount {
            return;
        }
        let supply = self.goods_supply.get(good).copied().unwrap_or(0);
        if amount > old {
            self.goods_supply.insert(good.to_string(), supply + (amount - old));
            mt_event("mt_mint", json!({ "owner_id": account, "token_ids": [good], "amounts": [U128(amount - old)], "memo": "bought from suppliers" }));
        } else {
            self.goods_supply.insert(good.to_string(), supply.saturating_sub(old - amount));
            mt_event("mt_burn", json!({ "owner_id": account, "token_ids": [good], "amounts": [U128(old - amount)], "memo": "sold to townsfolk" }));
        }
        if amount == 0 {
            self.goods.remove(&key);
        } else {
            self.goods.insert(key, amount);
        }
    }

    /// Vizier mirrors trades with suppliers/townsfolk: sets exact balances, minting or burning the difference.
    pub fn sync_goods(&mut self, holdings: Vec<GoodsHolding>) {
        self.assert_vizier();
        for h in holdings {
            assert_good(&h.token_id);
            self.set_balance(&h.token_id, &h.account_id, h.amount.0);
        }
    }

    fn internal_mt_transfer(&mut self, sender: &AccountId, receiver: &AccountId, good: &str, amount: u128) {
        assert_good(good);
        require!(amount > 0, "Amount must be positive");
        require!(sender != receiver, "Sender and receiver must differ");
        let from_key = gkey(good, sender);
        let bal = self.goods.get(&from_key).copied().unwrap_or(0);
        require!(bal >= amount, "Insufficient balance");
        let left = bal - amount;
        if left == 0 { self.goods.remove(&from_key); } else { self.goods.insert(from_key, left); }
        let to_key = gkey(good, receiver);
        let to = self.goods.get(&to_key).copied().unwrap_or(0);
        self.goods.insert(to_key, to + amount);
    }

    #[payable]
    pub fn mt_transfer(&mut self, receiver_id: AccountId, token_id: String, amount: U128, approval: Option<(AccountId, u64)>, memo: Option<String>) {
        assert_one_yocto();
        require!(approval.is_none(), "Approvals are not supported");
        let sender = env::predecessor_account_id();
        self.internal_mt_transfer(&sender, &receiver_id, &token_id, amount.0);
        mt_event("mt_transfer", json!({ "old_owner_id": sender, "new_owner_id": receiver_id, "token_ids": [token_id], "amounts": [amount], "memo": memo }));
    }

    #[payable]
    pub fn mt_batch_transfer(&mut self, receiver_id: AccountId, token_ids: Vec<String>, amounts: Vec<U128>, approvals: Option<Vec<Option<(AccountId, u64)>>>, memo: Option<String>) {
        assert_one_yocto();
        require!(approvals.is_none(), "Approvals are not supported");
        require!(token_ids.len() == amounts.len(), "Length mismatch");
        let sender = env::predecessor_account_id();
        for (t, a) in token_ids.iter().zip(amounts.iter()) {
            self.internal_mt_transfer(&sender, &receiver_id, t, a.0);
        }
        mt_event("mt_transfer", json!({ "old_owner_id": sender, "new_owner_id": receiver_id, "token_ids": token_ids, "amounts": amounts, "memo": memo }));
    }

    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        U128(self.goods.get(&gkey(&token_id, &account_id)).copied().unwrap_or(0))
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128> {
        token_ids.iter().map(|t| U128(self.goods.get(&gkey(t, &account_id)).copied().unwrap_or(0))).collect()
    }

    pub fn mt_supply(&self, token_id: String) -> Option<U128> {
        if !GOODS.contains(&token_id.as_str()) { return None; }
        Some(U128(self.goods_supply.get(&token_id).copied().unwrap_or(0)))
    }

    pub fn mt_batch_supply(&self, token_ids: Vec<String>) -> Vec<Option<U128>> {
        token_ids.into_iter().map(|t| self.mt_supply(t)).collect()
    }

    pub fn mt_token(&self, token_ids: Vec<String>) -> Vec<Option<serde_json::Value>> {
        token_ids.iter().map(|t| if GOODS.contains(&t.as_str()) { Some(json!({ "token_id": t, "owner_id": null })) } else { None }).collect()
    }

    pub fn get_charter(&self, token_id: TokenId) -> Option<Charter> {
        self.charters.get(&token_id).cloned()
    }

    pub fn get_day(&self) -> u32 {
        self.day
    }
}

// ---------- NEP-171 / 177 / 181 boilerplate ----------

#[near]
impl NonFungibleTokenCore for Contract {
    #[payable]
    fn nft_transfer(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>) {
        self.tokens.nft_transfer(receiver_id, token_id, approval_id, memo);
    }

    #[payable]
    fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        self.tokens.nft_transfer_call(receiver_id, token_id, approval_id, memo, msg)
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens.nft_token(token_id)
    }
}

#[near]
impl NonFungibleTokenResolver for Contract {
    #[private]
    fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: TokenId,
        approved_account_ids: Option<HashMap<AccountId, u64>>,
    ) -> bool {
        self.tokens.nft_resolve_transfer(previous_owner_id, receiver_id, token_id, approved_account_ids)
    }
}

#[near]
impl NonFungibleTokenEnumeration for Contract {
    fn nft_total_supply(&self) -> U128 {
        self.tokens.nft_total_supply()
    }
    fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens(from_index, limit)
    }
    fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        self.tokens.nft_supply_for_owner(account_id)
    }
    fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens_for_owner(account_id, from_index, limit)
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for Contract {
    fn nft_metadata(&self) -> NFTContractMetadata {
        self.metadata.get().unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;
    use near_sdk::NearToken;

    fn ctx(pred: AccountId) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(pred).attached_deposit(NearToken::from_millinear(100));
        b
    }

    #[test]
    fn vizier_can_move_charter_art() {
        testing_env!(ctx(accounts(0)).build());
        let mut c = Contract::new(accounts(0), accounts(5));
        c.mint_charter("charter-vey".into(), accounts(2), "Vey".into(), accounts(2), "silk".into(), Some("http://localhost:3000/art/vey.webp".into()));
        c.set_media("charter-vey".into(), "https://bazaar.example/art/vey.webp".into());
        assert_eq!(c.nft_token("charter-vey".into()).unwrap().metadata.unwrap().media.unwrap(), "https://bazaar.example/art/vey.webp");
    }

    #[test]
    #[should_panic(expected = "Only the Vizier")]
    fn only_vizier_moves_art() {
        testing_env!(ctx(accounts(0)).build());
        let mut c = Contract::new(accounts(0), accounts(5));
        c.mint_charter("charter-vey".into(), accounts(2), "Vey".into(), accounts(2), "silk".into(), None);
        testing_env!(ctx(accounts(3)).build());
        c.set_media("charter-vey".into(), "https://evil.example/x.webp".into());
    }

    #[test]
    fn mint_update_takeover() {
        testing_env!(ctx(accounts(0)).build());
        let mut c = Contract::new(accounts(0), accounts(5));
        c.mint_charter("charter-ozzo".into(), accounts(0), "Brother Ozzo".into(), accounts(2), "schemer".into(), None);
        c.mint_charter("charter-player".into(), accounts(1), "Your House".into(), accounts(3), "player".into(), None);

        c.update_charters(12, vec![CharterUpdate { token_id: "charter-ozzo".into(), net_worth: -19, gold: -19, stance: "liquidate".into(), bankrupt: true }]);
        assert!(c.get_charter("charter-ozzo".into()).unwrap().bankrupt);

        c.takeover("charter-ozzo".into(), accounts(1), 25, "charter-player".into());
        assert_eq!(c.nft_token("charter-ozzo".into()).unwrap().owner_id, accounts(1));
        let buyer = c.get_charter("charter-player".into()).unwrap();
        assert_eq!(buyer.takeovers, 1);
        assert_eq!(buyer.absorbed, vec!["charter-ozzo".to_string()]);
        let meta = c.nft_token("charter-player".into()).unwrap().metadata.unwrap();
        assert!(meta.extra.unwrap().contains("charter-ozzo"));
    }

    #[test]
    fn goods_sync_and_wallet_signed_transfer() {
        testing_env!(ctx(accounts(0)).build());
        let mut c = Contract::new(accounts(0), accounts(5));
        c.sync_goods(vec![GoodsHolding { account_id: accounts(2), token_id: "saffron".into(), amount: U128(30) }]);
        assert_eq!(c.mt_supply("saffron".into()).unwrap().0, 30);
        // the merchant wallet itself signs the transfer
        let mut b = ctx(accounts(2));
        b.attached_deposit(NearToken::from_yoctonear(1));
        testing_env!(b.build());
        c.mt_transfer(accounts(3), "saffron".into(), U128(12), None, Some("deal".into()));
        assert_eq!(c.mt_balance_of(accounts(2), "saffron".into()).0, 18);
        assert_eq!(c.mt_balance_of(accounts(3), "saffron".into()).0, 12);
        assert_eq!(c.mt_supply("saffron".into()).unwrap().0, 30);
        // vizier burns on retail sale
        testing_env!(ctx(accounts(0)).build());
        c.sync_goods(vec![GoodsHolding { account_id: accounts(3), token_id: "saffron".into(), amount: U128(2) }]);
        assert_eq!(c.mt_supply("saffron".into()).unwrap().0, 20);
    }

    fn yocto(who: AccountId, n: u128) {
        let mut b = ctx(who);
        b.attached_deposit(NearToken::from_yoctonear(n));
        testing_env!(b.build());
    }

    #[test]
    fn escrow_deal_is_atomic() {
        testing_env!(ctx(accounts(0)).build());
        let mut c = Contract::new(accounts(0), accounts(5));
        c.sync_goods(vec![GoodsHolding { account_id: accounts(2), token_id: "silk".into(), amount: U128(10) }]);
        // seller's wallet escrows 5 silk for the buyer at 500 yocto
        yocto(accounts(2), 1);
        c.offer_goods("d1".into(), accounts(3), "silk".into(), U128(5), U128(500));
        assert_eq!(c.mt_balance_of(accounts(2), "silk".into()).0, 5);
        assert!(c.get_offer("d1".into()).is_some());
        // buyer's wallet pays: goods arrive in the same call
        yocto(accounts(3), 500);
        c.accept_goods("d1".into());
        assert_eq!(c.mt_balance_of(accounts(3), "silk".into()).0, 5);
        assert!(c.get_offer("d1".into()).is_none());
        assert_eq!(c.mt_supply("silk".into()).unwrap().0, 10);
    }

    #[test]
    #[should_panic(expected = "for another buyer")]
    fn only_the_named_buyer_can_accept() {
        testing_env!(ctx(accounts(0)).build());
        let mut c = Contract::new(accounts(0), accounts(5));
        c.sync_goods(vec![GoodsHolding { account_id: accounts(2), token_id: "tea".into(), amount: U128(4) }]);
        yocto(accounts(2), 1);
        c.offer_goods("d2".into(), accounts(3), "tea".into(), U128(4), U128(100));
        yocto(accounts(4), 100);
        c.accept_goods("d2".into());
    }

    #[test]
    #[should_panic(expected = "below the price")]
    fn underpaying_an_offer_fails() {
        testing_env!(ctx(accounts(0)).build());
        let mut c = Contract::new(accounts(0), accounts(5));
        c.sync_goods(vec![GoodsHolding { account_id: accounts(2), token_id: "tea".into(), amount: U128(4) }]);
        yocto(accounts(2), 1);
        c.offer_goods("d3".into(), accounts(3), "tea".into(), U128(4), U128(100));
        yocto(accounts(3), 99);
        c.accept_goods("d3".into());
    }

    #[test]
    fn seller_can_cancel_an_unaccepted_offer() {
        testing_env!(ctx(accounts(0)).build());
        let mut c = Contract::new(accounts(0), accounts(5));
        c.sync_goods(vec![GoodsHolding { account_id: accounts(2), token_id: "salt".into(), amount: U128(6) }]);
        yocto(accounts(2), 1);
        c.offer_goods("d4".into(), accounts(3), "salt".into(), U128(6), U128(60));
        assert_eq!(c.mt_balance_of(accounts(2), "salt".into()).0, 0);
        c.cancel_goods("d4".into());
        assert_eq!(c.mt_balance_of(accounts(2), "salt".into()).0, 6);
    }

    #[test]
    fn migrate_keeps_v3_state() {
        testing_env!(ctx(accounts(0)).build());
        let mut c = Contract::new(accounts(0), accounts(5));
        c.sync_goods(vec![GoodsHolding { account_id: accounts(2), token_id: "silk".into(), amount: U128(7) }]);
        yocto(accounts(2), 1);
        c.offer_goods("d0".into(), accounts(3), "silk".into(), U128(1), U128(10));
        // write the state in the v3 layout, as the deployed contract has it
        let v3 = ContractV3 {
            tokens: c.tokens,
            metadata: c.metadata,
            charters: c.charters,
            day: 9,
            treasury: c.treasury,
            goods: c.goods,
            goods_supply: c.goods_supply,
            listings: c.listings,
            offers: c.offers,
        };
        env::state_write(&v3);
        drop(v3); // flush cached map writes to storage
        testing_env!(ctx(accounts(0)).build());
        let m = Contract::migrate();
        assert_eq!(m.day, 9);
        assert_eq!(m.mt_balance_of(accounts(2), "silk".into()).0, 6);
        assert!(m.get_offer("d0".into()).is_some());
        assert_eq!(m.vault_of("charter-x".into()).0, 0);
    }

    // ---------- charter vaults + NEP-413 signed intents ----------
    use ed25519_dalek::{Signer, SigningKey};

    fn key(seed: u8) -> (SigningKey, String) {
        let sk = SigningKey::from_bytes(&[seed; 32]);
        let pk = PublicKey::from_parts(CurveType::ED25519, sk.verifying_key().to_bytes().to_vec()).unwrap();
        (sk, String::from(&pk))
    }

    fn register(c: &mut Contract, who: AccountId, pk: &str) {
        let mut b = ctx(who.clone());
        b.signer_account_id(who).signer_account_pk(PublicKey::from_str(pk).unwrap());
        testing_env!(b.build());
        c.register_signer();
    }

    fn sign(sk: &SigningKey, pk: &str, msg: &str, nonce: u8) -> SignedIntent {
        let recipient = env::current_account_id().to_string();
        let mut bytes = near_sdk::borsh::to_vec(&NEP413_TAG).unwrap();
        bytes.extend(near_sdk::borsh::to_vec(&Nep413Payload { message: msg.into(), nonce: [nonce; 32], recipient: recipient.clone(), callback_url: None }).unwrap());
        let sig = sk.sign(&env::sha256(&bytes)).to_bytes().to_vec();
        SignedIntent { message: msg.into(), nonce: vec![nonce; 32], recipient, public_key: pk.into(), signature: sig }
    }

    fn intent(signer: &AccountId, charter: &str, near: i128, goods: &str) -> String {
        format!(r#"{{"signer_id":"{}","charter":"{}","deadline_ms":99999999999999,"near":"{}","goods":{{{}}},"memo":"test"}}"#, signer, charter, near, goods)
    }

    /// two houses: A sells silk from its wallet, B pays from its charter vault
    fn market() -> (Contract, (SigningKey, String), (SigningKey, String)) {
        testing_env!(ctx(accounts(0)).build());
        let mut c = Contract::new(accounts(0), accounts(5));
        c.mint_charter("charter-a".into(), accounts(2), "A".into(), accounts(2), "a".into(), None);
        c.mint_charter("charter-b".into(), accounts(3), "B".into(), accounts(3), "b".into(), None);
        c.sync_goods(vec![GoodsHolding { account_id: accounts(2), token_id: "silk".into(), amount: U128(10) }]);
        yocto(accounts(3), 1000);
        c.vault_deposit("charter-b".into());
        let (ka, kb) = (key(1), key(2));
        register(&mut c, accounts(2), &ka.1);
        register(&mut c, accounts(3), &kb.1);
        (c, ka, kb)
    }

    #[test]
    fn signed_intents_settle_a_deal_atomically() {
        let (mut c, ka, kb) = market();
        let sell = sign(&ka.0, &ka.1, &intent(&accounts(2), "charter-a", 600, r#""silk":-4"#), 7);
        let buy = sign(&kb.0, &kb.1, &intent(&accounts(3), "charter-b", -600, r#""silk":4"#), 8);
        testing_env!(ctx(accounts(4)).build()); // any solver can submit the matched pair
        c.execute_intents(vec![sell, buy]);
        assert_eq!(c.vault_of("charter-a".into()).0, 600);
        assert_eq!(c.vault_of("charter-b".into()).0, 400);
        assert_eq!(c.mt_balance_of(accounts(2), "silk".into()).0, 6);
        assert_eq!(c.mt_balance_of(accounts(3), "silk".into()).0, 4);
        assert!(c.nonce_used(accounts(2), hex(&[7u8; 32])));
    }

    #[test]
    #[should_panic(expected = "NEAR does not net to zero")]
    fn intents_must_balance() {
        let (mut c, ka, kb) = market();
        let sell = sign(&ka.0, &ka.1, &intent(&accounts(2), "charter-a", 600, r#""silk":-4"#), 7);
        let buy = sign(&kb.0, &kb.1, &intent(&accounts(3), "charter-b", -500, r#""silk":4"#), 8);
        c.execute_intents(vec![sell, buy]);
    }

    #[test]
    #[should_panic(expected = "nonce already used")]
    fn an_intent_cannot_be_replayed() {
        let (mut c, ka, kb) = market();
        let sell = sign(&ka.0, &ka.1, &intent(&accounts(2), "charter-a", 100, r#""silk":-1"#), 7);
        let buy = sign(&kb.0, &kb.1, &intent(&accounts(3), "charter-b", -100, r#""silk":1"#), 8);
        c.execute_intents(vec![sell.clone(), buy.clone()]);
        c.execute_intents(vec![sell, buy]);
    }

    #[test]
    #[should_panic(expected = "Bad intent signature")]
    fn a_tampered_intent_is_rejected() {
        let (mut c, ka, kb) = market();
        let mut sell = sign(&ka.0, &ka.1, &intent(&accounts(2), "charter-a", 600, r#""silk":-4"#), 7);
        sell.message = intent(&accounts(2), "charter-a", 600, r#""silk":-1"#); // changed after signing
        let buy = sign(&kb.0, &kb.1, &intent(&accounts(3), "charter-b", -600, r#""silk":1"#), 8);
        let buy_fix = SignedIntent { ..buy };
        c.execute_intents(vec![sell, buy_fix]);
    }

    #[test]
    fn the_charters_money_follows_the_nft() {
        let (mut c, ka, kb) = market();
        // B's charter is listed and A buys it: from now on A, not B, controls B's vault
        testing_env!(ctx(accounts(0)).build());
        c.list_charter("charter-b".into(), U128(10), "agreed buyout".into());
        yocto(accounts(2), 10);
        c.buy_charter("charter-b".into(), Some("charter-a".into()));
        // B's old key can no longer spend from charter-b
        let spend = sign(&kb.0, &kb.1, &intent(&accounts(3), "charter-b", -100, ""), 9);
        let take = sign(&ka.0, &ka.1, &intent(&accounts(2), "charter-a", 100, ""), 10);
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.execute_intents(vec![spend, take])));
        assert!(res.is_err());
        // the new owner withdraws what the charter holds
        testing_env!(ctx(accounts(2)).build());
        let _ = c.vault_withdraw("charter-b".into(), U128(1000));
        assert_eq!(c.vault_of("charter-b".into()).0, 0);
    }

    #[test]
    #[should_panic(expected = "Insufficient balance")]
    fn cannot_send_goods_you_do_not_have() {
        testing_env!(ctx(accounts(0)).build());
        let mut c = Contract::new(accounts(0), accounts(5));
        let mut b = ctx(accounts(2));
        b.attached_deposit(NearToken::from_yoctonear(1));
        testing_env!(b.build());
        c.mt_transfer(accounts(3), "silk".into(), U128(1), None, None);
    }

    #[test]
    fn buyer_wallet_buys_listed_charter() {
        testing_env!(ctx(accounts(0)).build());
        let mut c = Contract::new(accounts(0), accounts(5));
        c.mint_charter("charter-ozzo".into(), accounts(2), "Brother Ozzo".into(), accounts(2), "schemer".into(), None);
        c.mint_charter("charter-player".into(), accounts(3), "Your House".into(), accounts(3), "player".into(), None);
        c.list_charter("charter-ozzo".into(), U128(1000), "bankrupt".into());
        let mut b = ctx(accounts(3));
        b.attached_deposit(NearToken::from_yoctonear(1000));
        testing_env!(b.build());
        c.buy_charter("charter-ozzo".into(), Some("charter-player".into()));
        assert_eq!(c.nft_token("charter-ozzo".into()).unwrap().owner_id, accounts(3));
        assert!(c.get_listing("charter-ozzo".into()).is_none());
        assert_eq!(c.get_charter("charter-player".into()).unwrap().absorbed, vec!["charter-ozzo".to_string()]);
    }

    #[test]
    #[should_panic(expected = "below the listing price")]
    fn underpaying_for_a_charter_fails() {
        testing_env!(ctx(accounts(0)).build());
        let mut c = Contract::new(accounts(0), accounts(5));
        c.mint_charter("charter-vey".into(), accounts(2), "Lady Vey".into(), accounts(2), "noble".into(), None);
        c.list_charter("charter-vey".into(), U128(1000), "buyout".into());
        let mut b = ctx(accounts(3));
        b.attached_deposit(NearToken::from_yoctonear(999));
        testing_env!(b.build());
        c.buy_charter("charter-vey".into(), None);
    }

    #[test]
    #[should_panic(expected = "Only the Vizier")]
    fn only_vizier_mints() {
        testing_env!(ctx(accounts(0)).build());
        let mut c = Contract::new(accounts(0), accounts(5));
        testing_env!(ctx(accounts(1)).build());
        c.mint_charter("x".into(), accounts(1), "x".into(), accounts(2), "x".into(), None);
    }

    #[test]
    #[should_panic(expected = "Only bankrupt")]
    fn no_takeover_of_healthy_merchant() {
        testing_env!(ctx(accounts(0)).build());
        let mut c = Contract::new(accounts(0), accounts(5));
        c.mint_charter("charter-vey".into(), accounts(0), "Lady Vey".into(), accounts(2), "noble".into(), None);
        c.takeover("charter-vey".into(), accounts(1), 10, "charter-vey".into());
    }
}
