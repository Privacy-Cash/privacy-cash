# Solana Privacy Protocol

Transfer privately on Solana. Private swap and LP will soon follow.

## Overview

This project implements a privacy protocol on Solana that allows users to:

1. **Shield SOL**: Deposit SOL into a privacy pool, generating a commitment that is added to a Merkle tree.
2. **Withdraw SOL**: Withdraw SOL from the privacy pool to any recipient address using zero-knowledge proofs.

The implementation uses zero-knowledge proofs to ensure that withdrawals cannot be linked to deposits, providing privacy for Solana transactions.

## Project Structure

- **program/**: Solana on-chain program (smart contract)
  - **src/**: Rust source code for the program
  - **test/**: Tests
  - **Cargo.toml**: Rust dependencies and configuration

## Prerequisites

- Solana CLI 2.1.18 or later
- Rust 1.79.0 or compatible version
- Node.js 16 or later
- npm or yarn
- Circom v2.2.2 https://docs.circom.io/getting-started/installation/#installing-dependencies

## Installation

### ZK Circuits
1. Navigate to the script directory:
   ```bash
   cd scripts
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Generate circuits:
   ```bash
   ./buildCircuit_prod_solana.sh 2
   ./buildCircuit_prod_solana.sh 16
   ```
4. Generate verifying keys
   ```bash
   cd artifacts/circuits
   npx snarkjs zkey export verificationkey transaction2.zkey verifyingkey2.json
   npx snarkjs zkey export verificationkey transaction16.zkey verifyingkey16.json
   ```
### ZK Proofs
1. Navigate to the script directory:
   ```bash
   cd scripts
   ```
2. Generate a sample proof (with a first deposit proof, and another withdrawal proof):
   ```bash
   ts-node sample_proof_generator.ts
   ```

### Anchor Program
1. Navigate to the program directory:
   ```bash
   cd anchor
   ```

2. Build the program:
   ```bash
   anchor build
   ```

3. Run unit test:
   ```bash
   cargo test
   ```

4. Run integration test:
   ```bash
   anchor test
   ```

5. Deploy the program to devnet:
   ```bash
   anchor build
   anchor deploy --provider.cluster devnet
   ```

6. Initialize the program on devnet
   ```base
   npm run start initialize_program_devnet.ts
   ```

### Indexer
1. Navigate to the indexer directory:
   ```bash
   cd indexer
   ```

2. Install the dependencies:
   ```bash
   npm run
   ```

3. Running tests:
   ```bash
   npm test
   ```

4. Start the indexer:
   ```bash
   tsc && npm start
   ```

# Scripts
1.  Navigate to the indexer directory:
   ```bash
   cd scripts
   ```

2. Get your own decrypted utxos
   ```bash
   ts-node fetch_user_utxos.ts
   ```

3. Get fees and protocol balances
   ```bash
   ts-node check_fees_balance.ts
   ```