//! Bazaar Sovereign — merchant charters.
//!
//! Every merchant in the game is a NEP-171 NFT ("charter"). The charter's metadata
//! points at the merchant's own NEAR wallet (a sub-account that holds its working
//! capital) and is rewritten as the business lives: net worth, gold, trading stance,
//! bankruptcy. When a merchant goes bankrupt its charter can be taken over — the NFT
//! moves to the buyer and the whole business (wallet, stock, debts) goes with it.
//!
//! The game server is the contract owner ("the Vizier"): it mints charters, writes
//! daily state, and executes takeovers. Anyone can read charters with the standard
//! NFT view methods or `get_charter`.

use near_contract_standards::non_fungible_token::core::{NonFungibleTokenCore, NonFungibleTokenResolver};
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::{NonFungibleToken, Token, TokenId};
use near_sdk::collections::LazyOption;
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{self, json};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearSchema, PanicOnDefault, PromiseOrValue};
use std::collections::HashMap;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    NonFungibleToken,
    Metadata,
    TokenMetadata,
    Enumeration,
    Approval,
    Charters,
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

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Contract {
    tokens: NonFungibleToken,
    metadata: LazyOption<NFTContractMetadata>,
    charters: LookupMap<TokenId, Charter>,
    day: u32,
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
    pub fn new(owner_id: AccountId) -> Self {
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
        }
    }

    fn assert_vizier(&self) {
        require!(env::predecessor_account_id() == self.tokens.owner_id, "Only the Vizier (game oracle) can do this");
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
    fn mint_update_takeover() {
        testing_env!(ctx(accounts(0)).build());
        let mut c = Contract::new(accounts(0));
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
    #[should_panic(expected = "Only the Vizier")]
    fn only_vizier_mints() {
        testing_env!(ctx(accounts(0)).build());
        let mut c = Contract::new(accounts(0));
        testing_env!(ctx(accounts(1)).build());
        c.mint_charter("x".into(), accounts(1), "x".into(), accounts(2), "x".into(), None);
    }

    #[test]
    #[should_panic(expected = "Only bankrupt")]
    fn no_takeover_of_healthy_merchant() {
        testing_env!(ctx(accounts(0)).build());
        let mut c = Contract::new(accounts(0));
        c.mint_charter("charter-vey".into(), accounts(0), "Lady Vey".into(), accounts(2), "noble".into(), None);
        c.takeover("charter-vey".into(), accounts(1), 10, "charter-vey".into());
    }
}
