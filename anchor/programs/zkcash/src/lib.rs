use anchor_lang::prelude::*;
use light_hasher::Poseidon;
use anchor_lang::solana_program::hash::{hash};
use ark_ff::PrimeField;
use ark_bn254::Fr;

declare_id!("F12PAMjHff2QHDwBTghE4BFzaaqNscKwno978La2vfQ5");

pub mod merkle_tree;
pub mod utils;
pub mod groth16;
pub mod errors;
use merkle_tree::{ROOT_HISTORY_SIZE, DEFAULT_HEIGHT, MerkleTree};

#[program]
pub mod zkcash {
    use crate::utils::{verify_proof, VERIFYING_KEY};

    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        // TODO: support SPL tokens.
        let tree_account = &mut ctx.accounts.tree_account.load_init()?;
        tree_account.authority = ctx.accounts.authority.key();
        tree_account.next_index = 0;
        tree_account.root_index = 0;
        tree_account.bump = ctx.bumps.tree_account;

        let fee_recipient = &mut ctx.accounts.fee_recipient_account;
        fee_recipient.authority = ctx.accounts.authority.key();
        fee_recipient.bump = ctx.bumps.fee_recipient_account;

        MerkleTree::initialize::<Poseidon>(tree_account);
        
        let token_account = &mut ctx.accounts.tree_token_account;
        token_account.authority = ctx.accounts.authority.key();
        token_account.bump = ctx.bumps.tree_token_account;
        
        msg!("Sparse Merkle Tree initialized successfully");
        Ok(())
    }

    pub fn transact(ctx: Context<Transact>, proof: Proof, ext_data: ExtData) -> Result<()> {
        let tree_account = &mut ctx.accounts.tree_account.load_mut()?;

        // check the authority is the same as the one in the accounts
        let authority_key = ctx.accounts.authority.key();
        require!(
            authority_key == tree_account.authority.key() &&
            authority_key == ctx.accounts.fee_recipient_account.authority.key() &&
            authority_key == ctx.accounts.tree_token_account.authority.key(),
            ErrorCode::Unauthorized
        );

        // check if proof.root is in the tree_account's proof history
        require!(
            MerkleTree::is_known_root(&tree_account, proof.root),
            ErrorCode::UnknownRoot
        );

        // check if the ext_data hashes to the same ext_data in the proof
        let mut serialized_ext_data = Vec::new();
        ext_data.serialize(&mut serialized_ext_data)?;
        let calculated_ext_data_hash = hash(&serialized_ext_data).to_bytes();

        require!(
            Fr::from_le_bytes_mod_order(&calculated_ext_data_hash) == Fr::from_be_bytes_mod_order(&proof.ext_data_hash),
            ErrorCode::ExtDataHashMismatch
        );

        require!(
            utils::check_public_amount(ext_data.ext_amount, ext_data.fee, proof.public_amount),
            ErrorCode::InvalidPublicAmountData
        );
        
        let ext_amount = ext_data.ext_amount;
        let fee = ext_data.fee;

        // verify the proof
        require!(verify_proof(proof.clone(), VERIFYING_KEY), ErrorCode::InvalidProof);

        if ext_amount > 0 {
            // If it's a deposit, transfer the SOL to the tree token account.
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.signer.to_account_info(),
                        to: ctx.accounts.tree_token_account.to_account_info(),
                    },
                ),
                ext_amount as u64,
            )?;
        } else if ext_amount < 0 {
            // PDA can't directly sign transactions, so we need to transfer SOL via try_borrow_mut_lamports
            let tree_token_account_info = ctx.accounts.tree_token_account.to_account_info();
            let recipient_account_info = ctx.accounts.recipient.to_account_info();

            let ext_amount_abs = -ext_amount as u64;
            require!(tree_token_account_info.lamports() >= ext_amount_abs, ErrorCode::InsufficientFundsForWithdrawal);

            **tree_token_account_info.try_borrow_mut_lamports()? -= ext_amount_abs;
            **recipient_account_info.try_borrow_mut_lamports()? += ext_amount_abs;
        }
        
        if fee > 0 {
            let tree_token_account_info = ctx.accounts.tree_token_account.to_account_info();
            let fee_recipient_account_info = ctx.accounts.fee_recipient_account.to_account_info();

            require!(tree_token_account_info.lamports() >= fee, ErrorCode::InsufficientFundsForFee);

            **tree_token_account_info.try_borrow_mut_lamports()? -= fee;
            **fee_recipient_account_info.try_borrow_mut_lamports()? += fee;
        }

        let next_index_to_insert = tree_account.next_index;
        MerkleTree::append::<Poseidon>(proof.output_commitments[0], tree_account);
        MerkleTree::append::<Poseidon>(proof.output_commitments[1], tree_account);

        ctx.accounts.commitment0.commitment = proof.output_commitments[0];
        ctx.accounts.commitment0.encrypted_output = ext_data.encrypted_output1.clone();
        ctx.accounts.commitment0.index = next_index_to_insert;
        ctx.accounts.commitment0.bump = ctx.bumps.commitment0;
        
        ctx.accounts.commitment1.commitment = proof.output_commitments[1];
        ctx.accounts.commitment1.encrypted_output = ext_data.encrypted_output2.clone();
        ctx.accounts.commitment1.index = next_index_to_insert + 1;
        ctx.accounts.commitment1.bump = ctx.bumps.commitment1;
        
        msg!("Transaction completed successfully");
        Ok(())
    }
}

// all public inputs needs to be in big endian format
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Proof {
    pub proof_a: [u8; 64],
    pub proof_b: [u8; 128],
    pub proof_c: [u8; 64],
    pub root: [u8; 32],
    pub public_amount: [u8; 32],
    pub ext_data_hash: [u8; 32],
    pub input_nullifiers: [[u8; 32]; 2],
    pub output_commitments: [[u8; 32]; 2],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ExtData {
    pub recipient: Pubkey,
    pub ext_amount: i64,
    pub encrypted_output1: Vec<u8>,
    pub encrypted_output2: Vec<u8>,
    pub fee: u64,
    // Keep this for future SPL token support
    pub token_mint: Pubkey,
}

#[derive(Accounts)]
#[instruction(proof: Proof, ext_data: ExtData)]
pub struct Transact<'info> {
    #[account(
        mut,
        seeds = [b"merkle_tree", authority.key().as_ref()],
        bump = tree_account.load()?.bump,
        has_one = authority @ ErrorCode::Unauthorized
    )]
    pub tree_account: AccountLoader<'info, MerkleTreeAccount>,
    
    /// Nullifier account to mark the first input as spent.
    /// Using `init` without `init_if_needed` ensures that the transaction
    /// will automatically fail with a system program error if this nullifier
    /// has already been used (i.e., if the account already exists).
    #[account(
        init,
        payer = signer,
        space = 8 + std::mem::size_of::<NullifierAccount>(),
        seeds = [b"nullifier0", proof.input_nullifiers[0].as_ref()],
        bump
    )]
    pub nullifier0: Account<'info, NullifierAccount>,
    
    /// Nullifier account to mark the second input as spent.
    /// Using `init` without `init_if_needed` ensures that the transaction
    /// will automatically fail with a system program error if this nullifier
    /// has already been used (i.e., if the account already exists).
    #[account(
        init,
        payer = signer,
        space = 8 + std::mem::size_of::<NullifierAccount>(),
        seeds = [b"nullifier1", proof.input_nullifiers[1].as_ref()],
        bump
    )]
    pub nullifier1: Account<'info, NullifierAccount>,
    
    #[account(
        init,
        payer = signer,
        space = 8 + std::mem::size_of::<CommitmentAccount>() + ext_data.encrypted_output1.len(),
        seeds = [b"commitment0", proof.output_commitments[0].as_ref()],
        bump
    )]
    pub commitment0: Account<'info, CommitmentAccount>,
    
    #[account(
        init,
        payer = signer,
        space = 8 + std::mem::size_of::<CommitmentAccount>() + ext_data.encrypted_output2.len(),
        seeds = [b"commitment1", proof.output_commitments[1].as_ref()],
        bump
    )]
    pub commitment1: Account<'info, CommitmentAccount>,
    
    #[account(
        mut,
        seeds = [b"tree_token", authority.key().as_ref()],
        bump = tree_token_account.bump,
        has_one = authority @ ErrorCode::Unauthorized
    )]
    pub tree_token_account: Account<'info, TreeTokenAccount>,
    
    #[account(mut)]
    pub recipient: SystemAccount<'info>,
    
    #[account(
        mut,
        seeds = [b"fee_recipient", authority.key().as_ref()],
        bump = fee_recipient_account.bump,
        has_one = authority @ ErrorCode::Unauthorized
    )]
    pub fee_recipient_account: Account<'info, FeeRecipientAccount>,
    
    /// The authority account is the account that created the tree and fee recipient PDAs
    pub authority: SystemAccount<'info>,
    
    /// The account that is signing the transaction
    #[account(mut)]
    pub signer: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<MerkleTreeAccount>(),
        seeds = [b"merkle_tree", authority.key().as_ref()],
        bump
    )]
    pub tree_account: AccountLoader<'info, MerkleTreeAccount>,
    
    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<FeeRecipientAccount>(),
        seeds = [b"fee_recipient", authority.key().as_ref()],
        bump
    )]
    pub fee_recipient_account: Account<'info, FeeRecipientAccount>,
    
    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<TreeTokenAccount>(),
        seeds = [b"tree_token", authority.key().as_ref()],
        bump
    )]
    pub tree_token_account: Account<'info, TreeTokenAccount>,
    
    #[account(mut)]
    pub authority: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[account]
pub struct FeeRecipientAccount {
    pub authority: Pubkey,
    pub bump: u8,
}

#[account]
pub struct TreeTokenAccount {
    pub authority: Pubkey,
    pub bump: u8,
}

#[account]
pub struct NullifierAccount {
    /// This account's existence indicates that the nullifier has been used.
    /// No fields needed other than bump for PDA verification.
    pub bump: u8,
}

#[account]
pub struct CommitmentAccount {
    pub commitment: [u8; 32],
    pub encrypted_output: Vec<u8>,
    pub index: u64,
    pub bump: u8,
}

#[account(zero_copy)]
pub struct MerkleTreeAccount {
    pub authority: Pubkey,
    pub next_index: u64,
    pub subtrees: [[u8; 32]; DEFAULT_HEIGHT],
    pub root: [u8; 32],
    pub root_history: [[u8; 32]; ROOT_HISTORY_SIZE],
    pub root_index: u64,
    pub bump: u8,
    // The pub _padding: [u8; 7] is needed because of the #[account(zero_copy)] attribute.
    // This attribute enables zero-copy deserialization for optimized performance but requires structs to have specific memory alignments.
    pub _padding: [u8; 7],
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
    InvalidPublicAmountData,
    #[msg("Insufficient funds for withdrawal")]
    InsufficientFundsForWithdrawal,
    #[msg("Insufficient funds for fee")]
    InsufficientFundsForFee,
    #[msg("Proof is invalid")]
    InvalidProof,
    #[msg("Invalid fee: fee must be less than MAX_ALLOWED_VAL (2^248).")]
    InvalidFee,
    #[msg("Invalid ext amount: absolute ext_amount must be less than MAX_ALLOWED_VAL (2^248).")]
    InvalidExtAmount,
    #[msg("Public amount calculation resulted in an overflow/underflow.")]
    PublicAmountCalculationError,
}