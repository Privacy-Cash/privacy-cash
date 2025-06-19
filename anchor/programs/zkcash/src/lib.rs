use anchor_lang::prelude::*;
use light_hasher::Poseidon;
use anchor_lang::solana_program::hash::{hash};
use anchor_lang::solana_program::sysvar::rent::Rent;
use ark_ff::PrimeField;
use ark_bn254::Fr;
use anchor_spl::token::{self, Token, TokenAccount, Mint, Transfer, SyncNative};

declare_id!("AW7zH2XvbZZuXtF7tcfCRzuny7L89GGqB3z3deGpejWQ");

pub mod merkle_tree;
pub mod utils;
pub mod groth16;
pub mod errors;
use merkle_tree::{ROOT_HISTORY_SIZE, DEFAULT_HEIGHT, MerkleTree};

// Native SOL mint (WSOL mint address)
pub const NATIVE_SOL_MINT: Pubkey = anchor_spl::token::spl_token::native_mint::ID;

// Helper function to check if we're dealing with WSOL (native SOL)
fn is_native_sol(token_mint: &Pubkey) -> bool {
    *token_mint == NATIVE_SOL_MINT
}

#[program]
pub mod zkcash {
    use super::*;

    pub fn initialize_tree(ctx: Context<InitializeTree>, token_mint: Pubkey) -> Result<()> {
        let tree_account = &mut ctx.accounts.tree_account.load_init()?;
        tree_account.authority = ctx.accounts.authority.key();
        tree_account.token_mint = token_mint;
        tree_account.next_index = 0;
        tree_account.root_index = 0;
        tree_account.bump = ctx.bumps.tree_account;

        MerkleTree::initialize::<Poseidon>(tree_account);
        
        let vault_authority = &mut ctx.accounts.vault_authority;
        vault_authority.authority = ctx.accounts.authority.key();
        vault_authority.token_mint = token_mint;
        vault_authority.vault_ata = ctx.accounts.vault_ata.key();
        vault_authority.bump = ctx.bumps.vault_authority;
        
        msg!("Sparse Merkle Tree initialized successfully for mint: {}", token_mint);
        Ok(())
    }

    /**
     * Users deposit or withdraw from the program.
     * 
     * Reentrant attacks are not possible, because nullifier creation is checked by anchor first.
     */
    #[inline(never)]
    pub fn transact(mut ctx: Context<Transact>, proof: Proof, ext_data: ExtData) -> Result<()> {
        // Split into smaller functions to reduce stack frame
        verify_and_process_transaction(&mut ctx, proof, ext_data)
    }
}

#[inline(never)]
fn verify_and_process_transaction(ctx: &mut Context<Transact>, proof: Proof, ext_data: ExtData) -> Result<()> {
        // Manual PDA validation for security
        let token_mint_key = ctx.accounts.token_mint.key();
        let authority_key = ctx.accounts.authority.key();
        
        // Validate nullifier PDAs
        let (expected_nullifier0, nullifier0_bump) = Pubkey::find_program_address(
            &[b"nullifier", token_mint_key.as_ref(), &proof.input_nullifiers[0]],
            ctx.program_id
        );
        require!(ctx.accounts.nullifier0.key() == expected_nullifier0, ErrorCode::Unauthorized);
        
        let (expected_nullifier1, nullifier1_bump) = Pubkey::find_program_address(
            &[b"nullifier", token_mint_key.as_ref(), &proof.input_nullifiers[1]],
            ctx.program_id
        );
        require!(ctx.accounts.nullifier1.key() == expected_nullifier1, ErrorCode::Unauthorized);
        
        // Validate commitment PDAs
        let (expected_commitment0, commitment0_bump) = Pubkey::find_program_address(
            &[b"commitment", token_mint_key.as_ref(), &proof.output_commitments[0]],
            ctx.program_id
        );
        require!(ctx.accounts.commitment0.key() == expected_commitment0, ErrorCode::Unauthorized);
        
        let (expected_commitment1, commitment1_bump) = Pubkey::find_program_address(
            &[b"commitment", token_mint_key.as_ref(), &proof.output_commitments[1]],
            ctx.program_id
        );
        require!(ctx.accounts.commitment1.key() == expected_commitment1, ErrorCode::Unauthorized);

        let tree_account = &mut ctx.accounts.tree_account.load_mut()?;

        // check the authority is the same as the one in the accounts
        require!(
            authority_key == tree_account.authority &&
            authority_key == ctx.accounts.vault_authority.authority,
            ErrorCode::Unauthorized
        );

        // Verify token mint matches
        let token_mint = ctx.accounts.token_mint.key();
        require!(
            token_mint == tree_account.token_mint &&
            token_mint == ctx.accounts.vault_authority.token_mint,
            ErrorCode::TokenMintMismatch
        );

        // check if proof.root is in the tree_account's proof history
        require!(
            MerkleTree::is_known_root(&tree_account, proof.root),
            ErrorCode::UnknownRoot
        );

        // check if the ext_data hashes to the same ext_data in the proof
        // Move serialization to heap to reduce stack frame size
        let mut serialized_ext_data = Box::new(Vec::new());
        ext_data.serialize(&mut *serialized_ext_data)?;
        let calculated_ext_data_hash = hash(&*serialized_ext_data).to_bytes();

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

        // Move verifying key and proof to heap to reduce stack frame size
        let verifying_key = Box::new(utils::VERIFYING_KEY);
        
        // verify the proof
        require!(utils::verify_proof(proof.clone(), &*verifying_key), ErrorCode::InvalidProof);

        // Handle transfers - simplified approach using direct vault operations
        if ext_amount > 0 {
            handle_deposit(&ctx, ext_amount as u64)?;
        } else if ext_amount < 0 {
            let withdraw_amount = ext_amount.checked_neg()
                .ok_or(ErrorCode::ArithmeticOverflow)?
                .try_into()
                .map_err(|_| ErrorCode::InvalidExtAmount)?;
            handle_withdraw(&ctx, withdraw_amount)?;
        }
        
        if fee > 0 {
            handle_fee(&ctx, fee)?;
        }

        let next_index_to_insert = tree_account.next_index;
        MerkleTree::append::<Poseidon>(proof.output_commitments[0], tree_account)?;
        MerkleTree::append::<Poseidon>(proof.output_commitments[1], tree_account)?;

        // Assign data directly to reduce stack allocations
        ctx.accounts.commitment0.commitment = proof.output_commitments[0];
        ctx.accounts.commitment0.encrypted_output = ext_data.encrypted_output1;
        ctx.accounts.commitment0.index = next_index_to_insert;
        ctx.accounts.commitment0.bump = commitment0_bump;
        
        ctx.accounts.commitment1.commitment = proof.output_commitments[1];
        ctx.accounts.commitment1.encrypted_output = ext_data.encrypted_output2;
        ctx.accounts.commitment1.index = next_index_to_insert.checked_add(1)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        ctx.accounts.commitment1.bump = commitment1_bump;
        
        // Set nullifier bumps
        ctx.accounts.nullifier0.bump = nullifier0_bump;
        ctx.accounts.nullifier1.bump = nullifier1_bump;
        
        Ok(())
    }

#[inline(never)]
fn handle_deposit(ctx: &Context<Transact>, amount: u64) -> Result<()> {
    let token_mint = ctx.accounts.token_mint.key();
    
    if is_native_sol(&token_mint) {
        // For SOL: Transfer SOL to vault, which will be treated as WSOL balance
        let transfer_instruction = anchor_lang::system_program::Transfer {
            from: ctx.accounts.signer.to_account_info(),
            to: ctx.accounts.vault_ata.to_account_info(),
        };
        let transfer_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            transfer_instruction,
        );
        anchor_lang::system_program::transfer(transfer_ctx, amount)?;
        
        // Sync native to update WSOL balance
        let sync_native_accounts = SyncNative {
            account: ctx.accounts.vault_ata.to_account_info(),
        };
        let sync_native_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            sync_native_accounts,
        );
        token::sync_native(sync_native_ctx)?;
    } else {
        // For SPL tokens: Direct transfer from user to vault
        let transfer_accounts = Transfer {
            from: ctx.accounts.user_token_account.to_account_info(),
            to: ctx.accounts.vault_ata.to_account_info(),
            authority: ctx.accounts.signer.to_account_info(),
        };
        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            transfer_accounts,
        );
        token::transfer(transfer_ctx, amount)?;
    }
    
    Ok(())
}

#[inline(never)]
fn handle_withdraw(ctx: &Context<Transact>, amount: u64) -> Result<()> {
    // Check vault has sufficient balance
    require!(
        ctx.accounts.vault_ata.amount >= amount,
        ErrorCode::InsufficientFundsForWithdrawal
    );

    let token_mint = ctx.accounts.token_mint.key();
    
    if is_native_sol(&token_mint) {
        // For SOL: Transfer WSOL from vault and close to get native SOL
        let authority_key = ctx.accounts.authority.key();
        let token_mint_key = ctx.accounts.token_mint.key();
        let seeds = &[
            b"vault_authority",
            token_mint_key.as_ref(),
            authority_key.as_ref(),
            &[ctx.accounts.vault_authority.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        // Transfer WSOL to user's WSOL account first
        let transfer_accounts = Transfer {
            from: ctx.accounts.vault_ata.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        };
        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            transfer_accounts,
            signer_seeds,
        );
        token::transfer(transfer_ctx, amount)?;
        
        // Close user's WSOL account to get native SOL
        let close_account_accounts = anchor_spl::token::CloseAccount {
            account: ctx.accounts.user_token_account.to_account_info(),
            destination: ctx.accounts.signer.to_account_info(),
            authority: ctx.accounts.signer.to_account_info(),
        };
        let close_account_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            close_account_accounts,
        );
        anchor_spl::token::close_account(close_account_ctx)?;
    } else {
        // For SPL tokens: Direct transfer from vault to user
        let authority_key = ctx.accounts.authority.key();
        let token_mint_key = ctx.accounts.token_mint.key();
        let seeds = &[
            b"vault_authority",
            token_mint_key.as_ref(),
            authority_key.as_ref(),
            &[ctx.accounts.vault_authority.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let transfer_accounts = Transfer {
            from: ctx.accounts.vault_ata.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        };
        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            transfer_accounts,
            signer_seeds,
        );
        token::transfer(transfer_ctx, amount)?;
    }
    
    Ok(())
}

#[inline(never)]
fn handle_fee(ctx: &Context<Transact>, fee_amount: u64) -> Result<()> {
    // Check vault has sufficient balance for fee
    require!(
        ctx.accounts.vault_ata.amount >= fee_amount,
        ErrorCode::InsufficientFundsForFee
    );

    // Transfer fee from vault to authority (simplified - using SOL transfer)
    let authority_key = ctx.accounts.authority.key();
    let token_mint_key = ctx.accounts.token_mint.key();
    let seeds = &[
        b"vault_authority",
        token_mint_key.as_ref(),
        authority_key.as_ref(),
        &[ctx.accounts.vault_authority.bump],
    ];
    let signer_seeds = &[&seeds[..]];

    let transfer_accounts = Transfer {
        from: ctx.accounts.vault_ata.to_account_info(),
        to: ctx.accounts.fee_recipient_token_account.to_account_info(),
        authority: ctx.accounts.vault_authority.to_account_info(),
    };
    let transfer_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        transfer_accounts,
        signer_seeds,
    );
    token::transfer(transfer_ctx, fee_amount)?;
    
    Ok(())
}

// Optimized account structure to reduce stack frame
#[derive(Accounts)]
pub struct Transact<'info> {
    #[account(
        mut,
        seeds = [b"merkle_tree", token_mint.key().as_ref(), authority.key().as_ref()],
        bump = tree_account.load()?.bump
    )]
    pub tree_account: AccountLoader<'info, MerkleTreeAccount>,
    
    /// CHECK: Nullifier PDA will be validated in instruction
    #[account(
        init,
        payer = signer,
        space = 9, // 8 (discriminator) + 1 (bump)
    )]
    pub nullifier0: Account<'info, NullifierAccount>,
    
    /// CHECK: Nullifier PDA will be validated in instruction
    #[account(
        init,
        payer = signer,
        space = 9, // 8 (discriminator) + 1 (bump)
    )]
    pub nullifier1: Account<'info, NullifierAccount>,
    
    /// CHECK: Commitment PDA will be validated in instruction
    #[account(
        init,
        payer = signer,
        space = 200, // 8 + 32 + 8 + 1 + ~150 for encrypted output (generous estimate)
    )]
    pub commitment0: Account<'info, CommitmentAccount>,
    
    /// CHECK: Commitment PDA will be validated in instruction
    #[account(
        init,
        payer = signer,
        space = 200, // 8 + 32 + 8 + 1 + ~150 for encrypted output (generous estimate)
    )]
    pub commitment1: Account<'info, CommitmentAccount>,
    
    #[account(
        mut,
        seeds = [b"vault_authority", token_mint.key().as_ref(), authority.key().as_ref()],
        bump = vault_authority.bump
    )]
    pub vault_authority: Account<'info, VaultAuthority>,
    
    pub token_mint: Account<'info, Mint>,
    #[account(mut)]
    pub vault_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub fee_recipient_token_account: Account<'info, TokenAccount>,
    pub authority: SystemAccount<'info>,
    #[account(mut)]
    pub signer: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(token_mint: Pubkey)]
pub struct InitializeTree<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<MerkleTreeAccount>(),
        seeds = [b"merkle_tree", token_mint.as_ref(), authority.key().as_ref()],
        bump
    )]
    pub tree_account: AccountLoader<'info, MerkleTreeAccount>,
    
    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<VaultAuthority>(),
        seeds = [b"vault_authority", token_mint.as_ref(), authority.key().as_ref()],
        bump
    )]
    pub vault_authority: Account<'info, VaultAuthority>,
    
    /// Vault ATA that will hold the tokens
    #[account(mut)]
    pub vault_ata: Account<'info, TokenAccount>,
    
    #[account(mut)]
    pub authority: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

/// Program Derived Address (PDA) that controls access to the vault_ata.
/// 
/// **Why This PDA is Necessary:**
/// SPL tokens require an authority to sign transfer operations. We can't use:
/// - MerkleTreeAccount: Uses zero_copy (read-only, can't sign transactions)
/// - User Authority: Would give users direct vault control (security risk)
/// - Program ID: Can't be direct authority of token accounts
/// 
/// This PDA serves as a "robot butler" that can sign transactions on behalf of the program.
/// 
/// **Control Hierarchy:**
/// - User Authority: Controls the overall tree and can initialize it
/// - Program: Controls this PDA through seed derivation  
/// - This PDA: Controls the vault_ata token account (can sign transfers)
/// - vault_ata: Holds the actual tokens
/// 
/// **Security Model:**
/// Only the program can generate valid signatures for this PDA by using the correct
/// seeds: ["vault_authority", token_mint, user_authority, bump]
#[account]
pub struct VaultAuthority {
    /// The user who owns/controls this privacy tree
    pub authority: Pubkey,
    /// The token mint this vault handles (WSOL for SOL, or SPL token mint)
    pub token_mint: Pubkey,
    /// The Associated Token Account that holds the actual tokens
    pub vault_ata: Pubkey,
    /// PDA bump seed for signature generation
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
    pub token_mint: Pubkey,
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
    #[msg("Arithmetic overflow/underflow occurred")]
    ArithmeticOverflow,
    #[msg("Token mint does not match the tree's token mint")]
    TokenMintMismatch,
}