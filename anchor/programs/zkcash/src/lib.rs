use anchor_lang::prelude::*;
use light_hasher::{Hasher, Poseidon};

declare_id!("F12PAMjHff2QHDwBTghE4BFzaaqNscKwno978La2vfQ5");

const ROOT_HISTORY_SIZE: usize = 100;
const DEFAULT_HEIGHT: usize = 20;

#[program]
pub mod zkcash {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let tree_account = &mut ctx.accounts.tree_account.load_init()?;
        tree_account.authority = ctx.accounts.authority.key();
        tree_account.next_index = 0;
        tree_account.root_index = 0;

        // Initialize empty subtrees and root history
        let zero_bytes = Poseidon::zero_bytes();
        for i in 0..DEFAULT_HEIGHT {
            tree_account.subtrees[i] = zero_bytes[i];
        }

        let initial_root = Poseidon::zero_bytes()[DEFAULT_HEIGHT];
        tree_account.root = initial_root;
        tree_account.root_history[0] = initial_root;
        
        msg!("Sparse Merkle Tree initialized successfully");
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

#[account(zero_copy)]
pub struct MerkleTreeAccount {
    pub authority: Pubkey,
    pub next_index: u64,  // Using u64 instead of usize for fixed size
    pub subtrees: [[u8; 32]; DEFAULT_HEIGHT],
    pub root: [u8; 32],
    pub root_history: [[u8; 32]; ROOT_HISTORY_SIZE],
    pub root_index: u64,  // Using u64 instead of usize for fixed size
}