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

## Installation

### Solana Program

1. Navigate to the program directory:
   ```bash
   cd program
   ```

2. Build the program:
   ```bash
   cargo build-sbf
   ```

3. Deploy the program to Solana devnet:
   ```bash
   solana config set --url https://api.devnet.solana.com
   solana program deploy target/deploy/zkcash.so --upgrade-authority upgrader-keypair.json
   ```

4. Note the program ID for use in the client:
   ```bash
   solana program show --programs
   ```

### Program ID
31XzrJ1snBa7tdhBRALYJHRmAmKJ5TQ5s3YXRuXppGdQ (devnet)

### Running Tests

1. Navigate to the program directory:
   ```bash
   cd program
   ```

2. Run tests:
   ```bash
   cargo test
   ```