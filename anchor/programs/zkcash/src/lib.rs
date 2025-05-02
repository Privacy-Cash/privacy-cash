use anchor_lang::prelude::*;
use light_hasher::Poseidon;

declare_id!("F12PAMjHff2QHDwBTghE4BFzaaqNscKwno978La2vfQ5");

pub mod merkle_tree;
use merkle_tree::{ROOT_HISTORY_SIZE, DEFAULT_HEIGHT, MerkleTree};

#[program]
pub mod zkcash {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let tree_account = &mut ctx.accounts.tree_account.load_init()?;
        tree_account.authority = ctx.accounts.authority.key();
        tree_account.next_index = 0;
        tree_account.root_index = 0;

        // Initialize the Merkle tree
        MerkleTree::initialize::<Poseidon>(tree_account);
        
        msg!("Sparse Merkle Tree initialized successfully");
        Ok(())
    }

    pub fn append(ctx: Context<Append>, leaf: [u8; 32]) -> Result<()> {
        let tree_account = &mut ctx.accounts.tree_account.load_mut()?;
        
        // Verify authority
        require!(
            tree_account.authority == ctx.accounts.authority.key(),
            ErrorCode::Unauthorized
        );
        
        // Append leaf to tree using the MerkleTree struct
        let _proof = MerkleTree::append::<Poseidon>(leaf, tree_account);
        
        msg!("Leaf appended successfully at index: {}", tree_account.next_index - 1);
        Ok(())
    }
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

#[derive(Accounts)]
pub struct Append<'info> {
    #[account(mut)]
    pub tree_account: AccountLoader<'info, MerkleTreeAccount>,
    
    pub authority: Signer<'info>,
}

#[account(zero_copy)]
pub struct MerkleTreeAccount {
    pub authority: Pubkey,
    pub next_index: u64,  // Using u64 instead of usize for fixed size
    pub subtrees: [[u8; 32]; DEFAULT_HEIGHT],
    pub root: [u8; 32],
    pub root_history: [[u8; 32]; ROOT_HISTORY_SIZE],
    pub root_index: u64,  // Using u64 instead of usize for fixed size
}

#[error_code]
pub enum ErrorCode {
    #[msg("Not authorized to perform this action")]
    Unauthorized,
}