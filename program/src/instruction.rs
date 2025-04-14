use solana_program::{
    pubkey::Pubkey,
};
use borsh::{BorshSerialize, BorshDeserialize};

// Define the ExtData struct
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq)]
pub struct ExtData {
    pub recipient: Option<Pubkey>,
    pub ext_amount: i64,
    pub encrypted_outputs: Vec<Vec<u8>>,
}

// Define the Proof struct
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq)]
pub struct Proof {
    pub root: [u8; 32],
    pub input_nullifiers: Vec<[u8; 32]>,
    pub output_commitments: [[u8; 32]; 2],
    pub public_amount: u64,
    pub ext_data_hash: [u8; 32],
    pub validity_proof: Vec<u128>,
    pub privacy_proof: Vec<u128>,
}

// Define PrivacyInstruction here
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq)]
pub enum PrivacyInstruction {
    /// Initialize a new merkle tree
    Initialize { 
       // empty params 
    },
    /// Process a privacy transaction
    Transact {
        ext_data: ExtData,
        proof_data: Proof,
    },
} 