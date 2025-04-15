use solana_program::{
    account_info::AccountInfo,
    entrypoint,
    entrypoint::ProgramResult,
    pubkey::Pubkey,
};

// Required modules
pub mod instruction;
pub mod processor;

// Re-export Merkle tree types
pub mod data_structures {
    pub mod sparse_merkle_tree;
}

// Entrypoint
entrypoint!(process_instruction);

// Process instruction
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    processor::Processor::process(program_id, accounts, instruction_data)
}