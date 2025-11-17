use thiserror::Error;

#[derive(Error, Debug, PartialEq, Eq)]
pub enum Groth16Error {
    #[error("Invalid G1 point length")]
    InvalidG1Length,
    
    #[error("Invalid G2 point length")]
    InvalidG2Length,
    
    #[error("Invalid public inputs length")]
    InvalidPublicInputsLength,
    
    #[error("Public input greater than field size")]
    PublicInputGreaterThanFieldSize,
    
    #[error("Preparing inputs G1 multiplication failed")]
    PreparingInputsG1MulFailed,
    
    #[error("Preparing inputs G1 addition failed")]
    PreparingInputsG1AdditionFailed,
    
    #[error("Proof verification failed")]
    ProofVerificationFailed,
} 