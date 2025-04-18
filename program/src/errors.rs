use thiserror::Error;

#[derive(Error, Debug, Eq, PartialEq)]
pub enum Groth16Error {
    #[error("Invalid G1 length")]
    InvalidG1Length,
    
    #[error("Invalid G2 length")]
    InvalidG2Length,
    
    #[error("Invalid public inputs length")]
    InvalidPublicInputsLength,
    
    #[error("Public input greater than field size")]
    PublicInputGreaterThanFieldSize,
    
    #[error("Failed preparing inputs: G1 multiplication failed")]
    PreparingInputsG1MulFailed,
    
    #[error("Failed preparing inputs: G1 addition failed")]
    PreparingInputsG1AdditionFailed,
    
    #[error("Proof verification failed")]
    ProofVerificationFailed,
} 