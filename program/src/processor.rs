use solana_program::{
    account_info::{AccountInfo},
    entrypoint::ProgramResult,
    pubkey::Pubkey,
};

use borsh::{BorshSerialize, BorshDeserialize};

use crate::instruction::{PrivacyInstruction, ExtData, Proof};

pub struct Processor;

impl Processor {
    pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], instruction_data: &[u8]) -> ProgramResult {
        let instruction = PrivacyInstruction::try_from_slice(instruction_data)?;
        
        match instruction {
            PrivacyInstruction::Initialize { merkle_tree_height } => {
                Self::process_initialize(program_id, accounts, merkle_tree_height)
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
        merkle_tree_height: u8,
    ) -> ProgramResult {
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
