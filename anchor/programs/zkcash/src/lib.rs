use anchor_lang::prelude::*;
use light_hasher::Poseidon;
use anchor_lang::solana_program::hash::{hash};

declare_id!("F12PAMjHff2QHDwBTghE4BFzaaqNscKwno978La2vfQ5");

pub mod merkle_tree;
pub mod utils;

use merkle_tree::{ROOT_HISTORY_SIZE, DEFAULT_HEIGHT, MerkleTree};

#[program]
pub mod zkcash {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let tree_account = &mut ctx.accounts.tree_account.load_init()?;
        tree_account.authority = ctx.accounts.authority.key();
        tree_account.next_index = 0;
        tree_account.root_index = 0;

        MerkleTree::initialize::<Poseidon>(tree_account);
        
        msg!("Sparse Merkle Tree initialized successfully");
        Ok(())
    }

    pub fn transact(ctx: Context<Transact>, proof: Proof, ext_data: ExtData) -> Result<()> {
        let tree_account = &mut ctx.accounts.tree_account.load_mut()?;

        // check if proof.root is in the tree_account's proof history
        require!(
            MerkleTree::is_known_root(&tree_account, proof.root),
            ErrorCode::UnknownRoot
        );

        // check if the ext_data hashes to the same ext_data in the proof
        let mut serialized_ext_data = Vec::new();
        ext_data.serialize(&mut serialized_ext_data)?;
        
        require!(
            hash(&serialized_ext_data).to_bytes() == proof.ext_data_hash,
            ErrorCode::ExtDataHashMismatch
        );

        // check if the public amount is valid
        let (ext_amount, fee) = utils::check_external_amount(ext_data.ext_amount, ext_data.fee, proof.public_amount)?;

        MerkleTree::append::<Poseidon>(proof.output_commitments[0], tree_account);
        MerkleTree::append::<Poseidon>(proof.output_commitments[1], tree_account);
        
        // Additional verification logic would go here
        // For example, verifying zero-knowledge proofs, checking nullifiers, etc.
        
        msg!("External data hash verification successful");
        Ok(())
    }
}

// all public inputs needs to be in big endian format
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Proof {
    pub proof: Vec<u8>,
    pub root: [u8; 32],
    pub input_nullifiers: Vec<[u8; 32]>,
    pub output_commitments: [[u8; 32]; 2],
    pub public_amount: [u8; 32],
    pub ext_data_hash: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ExtData {
    pub recipient: Pubkey,
    pub ext_amount: i64,
    pub encrypted_output1: Vec<u8>,
    pub encrypted_output2: Vec<u8>,
    pub fee: u64,
    pub token_mint: Pubkey,
}

#[derive(Accounts)]
pub struct Transact<'info> {
    #[account(mut)]
    pub tree_account: AccountLoader<'info, MerkleTreeAccount>,
    
    #[account(mut)]
    pub recipient: SystemAccount<'info>,
    
    pub signer: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<MerkleTreeAccount>()
    )]
    pub tree_account: AccountLoader<'info, MerkleTreeAccount>,
    
    #[account(mut)]
    pub authority: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[account(zero_copy)]
pub struct MerkleTreeAccount {
    pub authority: Pubkey,
    pub next_index: u64,
    pub subtrees: [[u8; 32]; DEFAULT_HEIGHT],
    pub root: [u8; 32],
    pub root_history: [[u8; 32]; ROOT_HISTORY_SIZE],
    pub root_index: u64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Not authorized to perform this action")]
    Unauthorized,
    #[msg("External data hash does not match the one in the proof")]
    ExtDataHashMismatch,
    #[msg("Root is not known in the tree")]
    UnknownRoot,
    #[msg("Public amount is invalid")]
    InvalidPublicAmountData
}