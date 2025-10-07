use anchor_lang::prelude::*;
use light_hasher::Poseidon;
use anchor_lang::solana_program::sysvar::rent::Rent;
use ark_ff::PrimeField;
use ark_bn254::Fr;

declare_id!("9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD");

pub mod merkle_tree;
pub mod utils;
pub mod groth16;
pub mod errors;

use merkle_tree::MerkleTree;

// Constants
const MERKLE_TREE_HEIGHT: u8 = 26;

#[cfg(any(feature = "localnet", test))]
pub const ADMIN_PUBKEY: Option<Pubkey> = None;

#[cfg(not(any(feature = "localnet", test)))]
pub const ADMIN_PUBKEY: Option<Pubkey> = Some(pubkey!("AWexibGxNFKTa1b5R5MN4PJr9HWnWRwf8EW9g8cLx3dM"));

#[program]
pub mod zkcash {
    use crate::utils::{verify_proof, VERIFYING_KEY};

    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        if let Some(admin_key) = ADMIN_PUBKEY {
            require!(ctx.accounts.authority.key().eq(&admin_key), ErrorCode::Unauthorized);
        }
        
        let tree_account = &mut ctx.accounts.tree_account.load_init()?;
        tree_account.authority = ctx.accounts.authority.key();
        tree_account.next_index = 0;
        tree_account.root_index = 0;
        tree_account.bump = ctx.bumps.tree_account;
        tree_account.max_deposit_amount = 1_000_000_000_000; // 1000 SOL default limit
        tree_account.height = MERKLE_TREE_HEIGHT; // Hardcoded height
        tree_account.root_history_size = 100; // Hardcoded root history size

        MerkleTree::initialize::<Poseidon>(tree_account)?;
        
        let token_account = &mut ctx.accounts.tree_token_account;
        token_account.authority = ctx.accounts.authority.key();
        token_account.bump = ctx.bumps.tree_token_account;
        
        // Initialize global config
        let global_config = &mut ctx.accounts.global_config;
        global_config.authority = ctx.accounts.authority.key();
        global_config.deposit_fee_rate = 0; // 0% - Free deposits
        global_config.withdrawal_fee_rate = 25; // 0.25% (25 basis points)
        global_config.fee_error_margin = 500; // 5% (500 basis points)
        global_config.bump = ctx.bumps.global_config;
        
        msg!("Sparse Merkle Tree initialized successfully with height: {}, root history size: {}, deposit limit: {} lamports, 
            deposit fee rate: {}, withdrawal fee rate: {}, fee error margin: {}",
            MERKLE_TREE_HEIGHT, 100, tree_account.max_deposit_amount, global_config.deposit_fee_rate, global_config.withdrawal_fee_rate, global_config.fee_error_margin);
        Ok(())
    }

    /**
     * Update the maximum deposit amount limit. Only the authority can call this.
     */
    pub fn update_deposit_limit(ctx: Context<UpdateDepositLimit>, new_limit: u64) -> Result<()> {
        let tree_account = &mut ctx.accounts.tree_account.load_mut()?;
        
        tree_account.max_deposit_amount = new_limit;
        
        msg!("Deposit limit updated to: {} lamports", new_limit);
        Ok(())
    }

    /**
     * Update global configuration. Only the authority can call this.
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
     * Users deposit or withdraw from the program.
     * 
     * Reentrant attacks are not possible, because nullifier creation is checked by anchor first.
     * 
     * encrypted_output1 and encrypted_output2 are passed as separate parameters to save instruction data space (~170 bytes).
     */
    pub fn transact(ctx: Context<Transact>, proof: Proof, ext_data_minified: ExtDataMinified, encrypted_output1: Vec<u8>, encrypted_output2: Vec<u8>) -> Result<()> {
        let tree_account = &mut ctx.accounts.tree_account.load_mut()?;
        let global_config = &ctx.accounts.global_config;

        // Reconstruct full ExtData from minified version and context accounts
        let ext_data = ExtData::from_minified(&ctx, ext_data_minified);

        // check if proof.root is in the tree_account's proof history
        require!(
            MerkleTree::is_known_root(&tree_account, proof.root),
            ErrorCode::UnknownRoot
        );

        // check if the ext_data hashes to the same ext_data in the proof
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

        let tree_token_account_info = ctx.accounts.tree_token_account.to_account_info();
        let rent = Rent::get()?;
        let rent_exempt_minimum = rent.minimum_balance(tree_token_account_info.data_len());

        if ext_amount > 0 {
            // Check deposit limit for deposits
            let deposit_amount = ext_amount as u64;
            require!(
                deposit_amount <= tree_account.max_deposit_amount,
                ErrorCode::DepositLimitExceeded
            );
            
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
            // No limit on withdrawals
            let recipient_account_info = ctx.accounts.recipient.to_account_info();

            let ext_amount_abs: u64 = ext_amount.checked_neg()
                .ok_or(ErrorCode::ArithmeticOverflow)?
                .try_into()
                .map_err(|_| ErrorCode::InvalidExtAmount)?;
            
            let total_required = ext_amount_abs
                .checked_add(fee)
                .ok_or(ErrorCode::ArithmeticOverflow)?
                .checked_add(rent_exempt_minimum)
                .ok_or(ErrorCode::ArithmeticOverflow)?;
            
            require!(
                tree_token_account_info.lamports() >= total_required,
                ErrorCode::InsufficientFundsForWithdrawal
            );

            let tree_token_balance = tree_token_account_info.lamports();
            let recipient_balance = recipient_account_info.lamports();
            
            let new_tree_token_balance = tree_token_balance.checked_sub(ext_amount_abs)
                .ok_or(ErrorCode::ArithmeticOverflow)?;
            let new_recipient_balance = recipient_balance.checked_add(ext_amount_abs)
                .ok_or(ErrorCode::ArithmeticOverflow)?;
                
            **tree_token_account_info.try_borrow_mut_lamports()? = new_tree_token_balance;
            **recipient_account_info.try_borrow_mut_lamports()? = new_recipient_balance;
        }
        
        if fee > 0 {
            let fee_recipient_account_info = ctx.accounts.fee_recipient_account.to_account_info();

            if ext_amount >= 0 {
                let total_required = fee
                    .checked_add(rent_exempt_minimum)
                    .ok_or(ErrorCode::ArithmeticOverflow)?;
                
                require!(
                    tree_token_account_info.lamports() >= total_required,
                    ErrorCode::InsufficientFundsForFee
                );
            }

            let tree_token_balance = tree_token_account_info.lamports();
            let fee_recipient_balance = fee_recipient_account_info.lamports();
            
            let new_tree_token_balance = tree_token_balance.checked_sub(fee)
                .ok_or(ErrorCode::ArithmeticOverflow)?;
            let new_fee_recipient_balance = fee_recipient_balance.checked_add(fee)
                .ok_or(ErrorCode::ArithmeticOverflow)?;
                
            **tree_token_account_info.try_borrow_mut_lamports()? = new_tree_token_balance;
            **fee_recipient_account_info.try_borrow_mut_lamports()? = new_fee_recipient_balance;
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

        ctx.accounts.commitment0.commitment = proof.output_commitments[0];
        ctx.accounts.commitment0.encrypted_output = encrypted_output1;
        ctx.accounts.commitment0.index = next_index_to_insert;
        ctx.accounts.commitment0.bump = ctx.bumps.commitment0;
        
        ctx.accounts.commitment1.commitment = proof.output_commitments[1];
        ctx.accounts.commitment1.encrypted_output = encrypted_output2;
        ctx.accounts.commitment1.index = second_index;
        ctx.accounts.commitment1.bump = ctx.bumps.commitment1;
        
        Ok(())
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

impl ExtData {
    fn from_minified(ctx: &Context<Transact>, minified: ExtDataMinified) -> Self {
        use crate::utils::SOL_ADDRESS;
        Self {
            recipient: ctx.accounts.recipient.key(),
            ext_amount: minified.ext_amount,
            fee: minified.fee,
            fee_recipient: ctx.accounts.fee_recipient_account.key(),
            mint_address: SOL_ADDRESS,
        }
    }
}

#[derive(Accounts)]
#[instruction(proof: Proof, ext_data_minified: ExtDataMinified, encrypted_output1: Vec<u8>, encrypted_output2: Vec<u8>)]
pub struct Transact<'info> {
    #[account(
        mut,
        seeds = [b"merkle_tree"],
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
        seeds = [b"nullifier0", proof.input_nullifiers[1].as_ref()],
        bump
    )]
    pub nullifier2: SystemAccount<'info>,
    
    #[account(
        seeds = [b"nullifier1", proof.input_nullifiers[0].as_ref()],
        bump
    )]
    pub nullifier3: SystemAccount<'info>,
    
    #[account(
        init,
        payer = signer,
        space = 8 + std::mem::size_of::<CommitmentAccount>() + encrypted_output1.len(),
        seeds = [b"commitment0", proof.output_commitments[0].as_ref()],
        bump
    )]
    pub commitment0: Account<'info, CommitmentAccount>,
    
    #[account(
        init,
        payer = signer,
        space = 8 + std::mem::size_of::<CommitmentAccount>() + encrypted_output2.len(),
        seeds = [b"commitment1", proof.output_commitments[1].as_ref()],
        bump
    )]
    pub commitment1: Account<'info, CommitmentAccount>,
    
    #[account(
        mut,
        seeds = [b"tree_token"],
        bump = tree_token_account.bump
    )]
    pub tree_token_account: Account<'info, TreeTokenAccount>,
    
    #[account(
        seeds = [b"global_config"],
        bump = global_config.bump
    )]
    pub global_config: Account<'info, GlobalConfig>,
    
    #[account(mut)]
    /// CHECK: user should be able to send funds to any types of accounts
    pub recipient: UncheckedAccount<'info>,
    
    #[account(mut)]
    /// CHECK: user should be able to send fees to any types of accounts
    pub fee_recipient_account: UncheckedAccount<'info>,
    
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
        seeds = [b"merkle_tree"],
        bump
    )]
    pub tree_account: AccountLoader<'info, MerkleTreeAccount>,
    
    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<TreeTokenAccount>(),
        seeds = [b"tree_token"],
        bump
    )]
    pub tree_token_account: Account<'info, TreeTokenAccount>,
    
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
pub struct UpdateDepositLimit<'info> {
    #[account(
        mut,
        seeds = [b"merkle_tree"],
        bump = tree_account.load()?.bump,
        has_one = authority @ ErrorCode::Unauthorized
    )]
    pub tree_account: AccountLoader<'info, MerkleTreeAccount>,
    
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
}