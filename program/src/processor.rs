use solana_program::{
    account_info::{AccountInfo, next_account_info},
    entrypoint::ProgramResult,
    program::{invoke},
    pubkey::Pubkey,
    program_error::ProgramError,
    system_instruction,
    sysvar::{rent::Rent, Sysvar},
    msg,
};

use borsh::{BorshSerialize, BorshDeserialize};

use crate::instruction::{PrivacyInstruction, ExtData, Proof};

// Define Light Protocol system program ID as a constant
pub const LIGHT_SYSTEM_PROGRAM_ID: Pubkey = solana_program::pubkey!("SySTEM1eSU2p4BGQfQpimFEWWSC1XDFeun3Nqzz3rT7");

// Define MerkleTreeAccount struct for storing state
#[derive(BorshSerialize, BorshDeserialize)]
pub struct MerkleTreeAccount {
    pub state_tree: Pubkey,
}

pub struct Processor;

impl Processor {
    pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], instruction_data: &[u8]) -> ProgramResult {
        let instruction = PrivacyInstruction::try_from_slice(instruction_data)?;
        
        match instruction {
            PrivacyInstruction::Initialize { } => {
                Self::process_initialize(program_id, accounts)
            },
            PrivacyInstruction::Transact { 
                ext_data,
                proof_data
            } => {
                Self::process_transact(
                    program_id, 
                    accounts,
                    &proof_data,
                    &ext_data
                )
            },
        }
    }
    
    fn process_initialize(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
    ) -> ProgramResult {
        let account_info_iter = &mut accounts.iter();
    
        // Get accounts
        let payer = next_account_info(account_info_iter)?;
        let merkle_tree_account = next_account_info(account_info_iter)?;
        let state_tree = next_account_info(account_info_iter)?;
        let light_system_program = next_account_info(account_info_iter)?;
        let system_program = next_account_info(account_info_iter)?;
        let rent_sysvar = next_account_info(account_info_iter)?;
        
        // Verify the payer is a signer
        if !payer.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }
        
        // Calculate space needed for the merkle tree account
        let space = 32; // Size for Pubkey
        
        // Get rent sysvar
        let rent = Rent::from_account_info(rent_sysvar)?;
        
        // Calculate rent-exempt minimum balance
        let rent_lamports = rent.minimum_balance(space);
        
        // Create the merkle tree account as a program-owned account
        // This makes it rent exempt and owned by the program
        invoke(
            &system_instruction::create_account(
                payer.key,
                merkle_tree_account.key,
                rent_lamports,
                space as u64,
                program_id,
            ),
            &[payer.clone(), merkle_tree_account.clone()],
        )?;
        
        // Verify Light Protocol system program
        if light_system_program.key != &LIGHT_SYSTEM_PROGRAM_ID {
            return Err(ProgramError::IncorrectProgramId);
        }
        
        // Create instruction data for Light Protocol's initialize_state_tree
        // This is a simplified version - you'll need to check Light Protocol's actual instruction format
        let initialize_data = [0u8; 8]; // Instruction discriminator for initialize_state_tree
        
        // Call Light Protocol to initialize the state tree
        invoke(
            &solana_program::instruction::Instruction {
                program_id: light_system_program.key.clone(),
                accounts: vec![
                    solana_program::instruction::AccountMeta::new(*payer.key, true),
                    solana_program::instruction::AccountMeta::new(*state_tree.key, false),
                    solana_program::instruction::AccountMeta::new_readonly(*system_program.key, false),
                ],
                data: initialize_data.to_vec(),
            },
            &[
                payer.clone(),
                state_tree.clone(),
                system_program.clone(),
            ],
        )?;
        
        // Store the state tree pubkey in our account
        let merkle_tree_data = MerkleTreeAccount {
            state_tree: *state_tree.key,
        };
        
        merkle_tree_data.serialize(&mut *merkle_tree_account.data.borrow_mut())?;
        
        msg!("Merkle tree initialized successfully with rent-exempt account");
        Ok(())
    }
    
    fn process_transact(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        proof_data: &Proof,
        ext_data: &ExtData,
    ) -> ProgramResult {
        Ok(())
    }
}
