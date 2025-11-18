use anchor_lang::prelude::*;
use light_hasher::Poseidon;
use anchor_lang::solana_program::sysvar::rent::Rent;
use ark_ff::PrimeField;
use ark_bn254::Fr;
use anchor_spl::token::{self, Token, TokenAccount, Mint, Transfer as SplTransfer};
use anchor_spl::associated_token::AssociatedToken;

declare_id!("9buNGKLVHL9PDmGKCBQwtAXiGVaqmYHgup9gJYySRDxt");

pub mod merkle_tree;
pub mod utils;
pub mod groth16;
pub mod errors;

use merkle_tree::MerkleTree;

// Constants
const MERKLE_TREE_HEIGHT: u8 = 30;

#[cfg(any(feature = "localnet", feature = "localnet-mint-checked", test))]
pub const ADMIN_PUBKEY: Option<Pubkey> = None;

#[cfg(feature = "devnet")]
pub const ADMIN_PUBKEY: Option<Pubkey> = Some(pubkey!("97rSMQUukMDjA7PYErccyx7ZxbHvSDaeXp2ig5BwSrTf"));

#[cfg(not(any(feature = "localnet", feature = "localnet-mint-checked", feature = "devnet", test)))]
pub const ADMIN_PUBKEY: Option<Pubkey> = Some(pubkey!("AWexibGxNFKTa1b5R5MN4PJr9HWnWRwf8EW9g8cLx3dM"));

#[cfg(any(feature = "localnet", test))]
pub const ALLOW_ALL_SPL_TOKENS: bool = true;

#[cfg(not(any(feature = "localnet", test)))]
pub const ALLOW_ALL_SPL_TOKENS: bool = false;

#[cfg(feature = "devnet")]
pub const ALLOWED_TOKENS: &[Pubkey] = &[pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")];

#[cfg(not(feature = "devnet"))]
pub const ALLOWED_TOKENS: &[Pubkey] = &[pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")];

#[program]
pub mod zkcash {
    use crate::utils::{verify_proof, VERIFYING_KEY};

    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        if let Some(admin_key) = ADMIN_PUBKEY {
            require!(ctx.accounts.authority.key().eq(&admin_key), ErrorCode::Unauthorized);
        }
        
        // Initialize global config
        let global_config = &mut ctx.accounts.global_config;
        global_config.authority = ctx.accounts.authority.key();
        global_config.deposit_fee_rate = 0; // 0% - Free deposits
        global_config.withdrawal_fee_rate = 35; // 0.35% (35 basis points)
        global_config.fee_error_margin = 500; // 5% (500 basis points)
        global_config.bump = ctx.bumps.global_config;
        
        Ok(())
    }

    /**
     * Initialize a new merkle tree for a specific SPL token.
     * This allows each token type to have its own separate tree.
     * Only the authority can call this.
     */
    pub fn initialize_tree_account_for_spl_token(
        ctx: Context<InitializeTreeAccountForSplToken>,
        max_deposit_amount: u64
    ) -> Result<()> {
        if let Some(admin_key) = ADMIN_PUBKEY {
            require!(ctx.accounts.authority.key().eq(&admin_key), ErrorCode::Unauthorized);
        }

        // Validate that the mint is in the allowed tokens list
        require!(
            ALLOW_ALL_SPL_TOKENS || ALLOWED_TOKENS.contains(&ctx.accounts.mint.key()),
            ErrorCode::InvalidMintAddress
        );

        let tree_account = &mut ctx.accounts.tree_account.load_init()?;
        tree_account.authority = ctx.accounts.authority.key();
        tree_account.next_index = 0;
        tree_account.root_index = 0;
        tree_account.bump = ctx.bumps.tree_account;
        tree_account.max_deposit_amount = max_deposit_amount;
        tree_account.height = MERKLE_TREE_HEIGHT;
        tree_account.root_history_size = 100;

        MerkleTree::initialize::<Poseidon>(tree_account)?;

        msg!(
            "SPL Token merkle tree initialized for mint: {}, height: {}, root history size: {}, deposit limit: {}",
            ctx.accounts.mint.key(),
            MERKLE_TREE_HEIGHT,
            100,
            max_deposit_amount
        );

        Ok(())
    }

    /**
     * Update global configuration for SOL and SPL tokens. Only the authority can call this.
     */
    pub fn update_global_config(
        ctx: Context<UpdateGlobalConfig>, 
        deposit_fee_rate: Option<u16>,
        withdrawal_fee_rate: Option<u16>,
        fee_error_margin: Option<u16>
    ) -> Result<()> {
        let global_config = &mut ctx.accounts.global_config;
        
        if let Some(deposit_rate) = deposit_fee_rate {
            require!(deposit_rate <= 10000, ErrorCode::InvalidFeeRate);
            global_config.deposit_fee_rate = deposit_rate;
            msg!("Deposit fee rate updated to: {} basis points", deposit_rate);
        }
        
        if let Some(withdrawal_rate) = withdrawal_fee_rate {
            require!(withdrawal_rate <= 10000, ErrorCode::InvalidFeeRate);
            global_config.withdrawal_fee_rate = withdrawal_rate;
            msg!("Withdrawal fee rate updated to: {} basis points", withdrawal_rate);
        }
        
        if let Some(fee_error_margin_val) = fee_error_margin {
            require!(fee_error_margin_val <= 10000, ErrorCode::InvalidFeeRate);
            global_config.fee_error_margin = fee_error_margin_val;
            msg!("Fee error margin updated to: {} basis points", fee_error_margin_val);
        }
        
        Ok(())
    }

    /**
     * Update the maximum deposit amount limit for a specific SPL token tree.
     * Only the authority can call this.
     */
    pub fn update_deposit_limit_for_spl_token(
        ctx: Context<UpdateDepositLimitForSplToken>,
        new_limit: u64
    ) -> Result<()> {
        let tree_account = &mut ctx.accounts.tree_account.load_mut()?;

        tree_account.max_deposit_amount = new_limit;

        msg!(
            "Deposit limit updated to: {} for mint: {}",
            new_limit,
            ctx.accounts.mint.key()
        );

        Ok(())
    }

    /**
     * Users deposit or withdraw SPL tokens from the program.
     * 
     * Reentrant attacks are not possible, because nullifier creation is checked by anchor first.
     */
    pub fn transact_spl(ctx: Context<TransactSpl>, proof: Proof, ext_data_minified: ExtDataMinified, encrypted_output1: Vec<u8>, encrypted_output2: Vec<u8>) -> Result<()> {
        let tree_account = &mut ctx.accounts.tree_account.load_mut()?;
        let global_config = &ctx.accounts.global_config;

        // Validate signer's token account ownership and mint
        require!(
            ctx.accounts.signer_token_account.owner == ctx.accounts.signer.key(),
            ErrorCode::InvalidTokenAccount
        );
        require!(
            ctx.accounts.signer_token_account.mint == ctx.accounts.mint.key(),
            ErrorCode::InvalidTokenAccountMintAddress
        );

        // Reconstruct full ExtData from minified version and context accounts
        let ext_data = ExtData::from_minified_spl(&ctx, ext_data_minified);

        // check if proof.root is in the tree_account's proof history
        require!(
            MerkleTree::is_known_root(&tree_account, proof.root),
            ErrorCode::UnknownRoot
        );

        require!(
            ALLOW_ALL_SPL_TOKENS || ALLOWED_TOKENS.contains(&ext_data.mint_address),
            ErrorCode::InvalidMintAddress
        );

        // For SOL, use all 32 bytes; for SPL tokens, use only first 31 bytes because circuit only supports 254 bits.
        // This is still safe because ALLOWED_TOKENS only has limited tokens that don't have the same first 31 bytes.
        // Also, 31 bytes collision is never known to happen, and such Ethereum only has 20 bytes for pubkey.
        let mint_bytes_for_hash: &[u8] = &ext_data.mint_address.to_bytes()[..31];
        
        require!(
            proof.mint_address == utils::mint_bytes_to_proof_format(mint_bytes_for_hash),
            ErrorCode::InvalidMintAddressInProof
        );

        let calculated_ext_data_hash = utils::calculate_complete_ext_data_hash(
            ext_data.recipient,
            ext_data.ext_amount,
            &encrypted_output1,
            &encrypted_output2,
            ext_data.fee,
            ext_data.fee_recipient,
            ext_data.mint_address,
        )?;

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

        // Validate fee calculation using utility function
        utils::validate_fee(
            ext_amount,
            fee,
            global_config.deposit_fee_rate,
            global_config.withdrawal_fee_rate,
            global_config.fee_error_margin,
        )?;

        // verify the proof
        require!(verify_proof(proof.clone(), VERIFYING_KEY), ErrorCode::InvalidProof);

        if ext_amount > 0 {
            // For SPL tokens, we don't limit the amount of tokens deposited.
            // SPL Token deposit: transfer from signer's token account to tree's ATA
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    SplTransfer {
                        from: ctx.accounts.signer_token_account.to_account_info(),
                        to: ctx.accounts.tree_ata.to_account_info(),
                        authority: ctx.accounts.signer.to_account_info(),
                    },
                ),
                ext_amount as u64,
            )?;
        } else if ext_amount < 0 {
            let ext_amount_abs: u64 = ext_amount.checked_neg()
                .ok_or(ErrorCode::ArithmeticOverflow)?
                .try_into()
                .map_err(|_| ErrorCode::InvalidExtAmount)?;
            
            // SPL Token withdrawal: transfer from tree's ATA to recipient's token account
            let bump = &[ctx.accounts.global_config.bump];
            let seeds: &[&[u8]] = &[b"global_config", bump];
            let signer_seeds = &[seeds];
            
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    SplTransfer {
                        from: ctx.accounts.tree_ata.to_account_info(),
                        to: ctx.accounts.recipient_token_account.to_account_info(),
                        authority: ctx.accounts.global_config.to_account_info(),
                    },
                    signer_seeds,
                ),
                ext_amount_abs,
            )?;
        }
        
        if fee > 0 {
            // SPL Token fee payment: transfer from tree's ATA to fee recipient's token account
            let bump = &[ctx.accounts.global_config.bump];
            let seeds: &[&[u8]] = &[b"global_config", bump];
            let signer_seeds = &[seeds];
            
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    SplTransfer {
                        from: ctx.accounts.tree_ata.to_account_info(),
                        to: ctx.accounts.fee_recipient_ata.to_account_info(),
                        authority: ctx.accounts.global_config.to_account_info(),
                    },
                    signer_seeds,
                ),
                fee,
            )?;
        }

        let next_index_to_insert = tree_account.next_index;
        MerkleTree::append::<Poseidon>(proof.output_commitments[0], tree_account)?;
        MerkleTree::append::<Poseidon>(proof.output_commitments[1], tree_account)?;

        let second_index = next_index_to_insert.checked_add(1)
            .ok_or(ErrorCode::ArithmeticOverflow)?;

        emit!(CommitmentData {
            index: next_index_to_insert,
            commitment: proof.output_commitments[0],
            encrypted_output: encrypted_output1.to_vec(),
        });

        emit!(CommitmentData {
            index: second_index,
            commitment: proof.output_commitments[1],
            encrypted_output: encrypted_output2.to_vec(),
        });
        
        Ok(())
    }
}

impl ExtData {
    fn from_minified_spl(ctx: &Context<TransactSpl>, minified: ExtDataMinified) -> Self {
        Self {
            recipient: ctx.accounts.recipient_token_account.key(),
            ext_amount: minified.ext_amount,
            fee: minified.fee,
            fee_recipient: ctx.accounts.fee_recipient_ata.key(),
            mint_address: ctx.accounts.mint.key(),
        }
    }
}

#[event]
pub struct CommitmentData {
    pub index: u64,
    pub commitment: [u8; 32],
    pub encrypted_output: Vec<u8>,
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
    pub mint_address: [u8; 32],
    pub input_nullifiers: [[u8; 32]; 2],
    pub output_commitments: [[u8; 32]; 2],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ExtData {
    pub recipient: Pubkey,
    pub ext_amount: i64,
    pub fee: u64,
    pub fee_recipient: Pubkey,
    pub mint_address: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ExtDataMinified {
    pub ext_amount: i64,
    pub fee: u64,
}

#[derive(Accounts)]
#[instruction(proof: Proof, ext_data_minified: ExtDataMinified, encrypted_output1: Vec<u8>, encrypted_output2: Vec<u8>)]
pub struct TransactSpl<'info> {
    #[account(
        mut,
        seeds = [b"merkle_tree", mint.key().as_ref()],
        bump = tree_account.load()?.bump
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
        seeds = [b"global_config"],
        bump = global_config.bump
    )]
    pub global_config: Account<'info, GlobalConfig>,
    
    /// The account that is signing the transaction
    #[account(mut)]
    pub signer: Signer<'info>,
    
    /// SPL Token mint account (required for token operations)
    pub mint: Account<'info, Mint>,
    
    /// Signer's token account (source for deposits)
    #[account(mut)]
    pub signer_token_account: Account<'info, TokenAccount>,

    /// CHECK: user should be able to send funds to any types of accounts
    pub recipient: UncheckedAccount<'info>,
    
    /// Recipient's token account (destination for withdrawals)
    /// Created automatically if it doesn't exist
    #[account(
        init_if_needed,
        payer = signer,
        associated_token::mint = mint,
        associated_token::authority = recipient
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,
    
    /// Tree's associated token account (destination for deposits, source for withdrawals)
    /// Created automatically if it doesn't exist
    #[account(
        init_if_needed,
        payer = signer,
        associated_token::mint = mint,
        associated_token::authority = global_config
    )]
    pub tree_ata: Account<'info, TokenAccount>,
    
    /// Fee recipient's associated token account (auto-derived from fee_recipient_account + mint)
    /// Fee recipient ATA is guaranteed to exist for supported tokens
    /// CHECK: Validated in the instruction logic
    #[account(mut)]
    pub fee_recipient_ata: UncheckedAccount<'info>,
    
    /// SPL Token program
    pub token_program: Program<'info, Token>,
    
    /// Associated Token program
    pub associated_token_program: Program<'info, AssociatedToken>,
    
    pub system_program: Program<'info, System>,
}

#[account]
pub struct TreeTokenAccount {
    pub authority: Pubkey,
    pub bump: u8,
}

#[account]
pub struct GlobalConfig {
    pub authority: Pubkey,
    pub deposit_fee_rate: u16,    // basis points (0-10000, where 10000 = 100%)
    pub withdrawal_fee_rate: u16, // basis points (0-10000, where 10000 = 100%)
    pub fee_error_margin: u16,    // basis points (0-10000, where 10000 = 100%)
    pub bump: u8,
}

#[account]
pub struct NullifierAccount {
    /// This account's existence indicates that the nullifier has been used.
    /// No fields needed other than bump for PDA verification.
    pub bump: u8,
}

#[account(zero_copy)]
pub struct MerkleTreeAccount {
    pub authority: Pubkey,
    pub next_index: u64,
    pub subtrees: [[u8; 32]; MERKLE_TREE_HEIGHT as usize],
    pub root: [u8; 32],
    pub root_history: [[u8; 32]; 100],
    pub root_index: u64,
    pub max_deposit_amount: u64,
    pub height: u8,
    pub root_history_size: u8,
    pub bump: u8,
    // The pub _padding: [u8; 5] is needed because of the #[account(zero_copy)] attribute.
    pub _padding: [u8; 5],
}




#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<GlobalConfig>(),
        seeds = [b"global_config"],
        bump
    )]
    pub global_config: Account<'info, GlobalConfig>,
    
    #[account(mut)]
    pub authority: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeTreeAccountForSplToken<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<MerkleTreeAccount>(),
        seeds = [b"merkle_tree", mint.key().as_ref()],
        bump
    )]
    pub tree_account: AccountLoader<'info, MerkleTreeAccount>,

    /// SPL Token mint account
    pub mint: Account<'info, Mint>,

    #[account(
        seeds = [b"global_config"],
        bump = global_config.bump
    )]
    pub global_config: Account<'info, GlobalConfig>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateDepositLimitForSplToken<'info> {
    #[account(
        mut,
        seeds = [b"merkle_tree", mint.key().as_ref()],
        bump = tree_account.load()?.bump,
        has_one = authority @ ErrorCode::Unauthorized
    )]
    pub tree_account: AccountLoader<'info, MerkleTreeAccount>,

    /// SPL Token mint account
    pub mint: Account<'info, Mint>,

    /// The authority account that can update the deposit limit
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateGlobalConfig<'info> {
    #[account(
        mut,
        seeds = [b"global_config"],
        bump = global_config.bump,
        has_one = authority @ ErrorCode::Unauthorized
    )]
    pub global_config: Account<'info, GlobalConfig>,
    
    /// The authority account that can update the global config
    pub authority: Signer<'info>,
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
    #[msg("Deposit limit exceeded")]
    DepositLimitExceeded,
    #[msg("Invalid fee rate: must be between 0 and 10000 basis points")]
    InvalidFeeRate,
    #[msg("Fee recipient does not match global configuration")]
    InvalidFeeRecipient,
    #[msg("Fee amount is below minimum required (must be at least (1 - fee_error_margin) * expected_fee)")]
    InvalidFeeAmount,
    #[msg("Recipient account does not match the ExtData recipient")]
    RecipientMismatch,
    #[msg("Merkle tree is full: cannot add more leaves")]
    MerkleTreeFull,
    #[msg("Invalid token account: account is not owned by the token program")]
    InvalidTokenAccount,
    #[msg("Invalid mint address: mint address is not allowed")]
    InvalidMintAddress,
    #[msg("Invalid token account mint address")]
    InvalidTokenAccountMintAddress,
    #[msg("Invalid mint address in proof")]
    InvalidMintAddressInProof,
}