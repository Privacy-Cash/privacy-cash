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

    // Add the transact instruction
    pub fn transact(ctx: Context<Transact>, proof: Proof, ext_data: ExtData) -> Result<()> {
        msg!("Transact instruction called");
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Proof {
    pub proof: Vec<u8>,
    pub root: [u8; 32],
    pub input_nullifiers: Vec<[u8; 32]>,
    pub output_commitments: [[u8; 32]; 2],
    pub public_amount: u64,
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

#[derive(Accounts)]
pub struct Append<'info> {
    #[account(mut)]
    pub tree_account: AccountLoader<'info, MerkleTreeAccount>,
    
    pub authority: Signer<'info>,
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
}