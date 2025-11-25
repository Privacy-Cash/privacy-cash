# Privacy Cash

Transfer SOL privately. Private SPL tokens transfer and private swap will soon follow.

The program is fully audited by Accretion, HashCloak, Zigtur and Kriko, and verified onchain (with hash c6f1e5336f2068dc1c1e1c64e92e3d8495b8df79f78011e2620af60aa43090c5).

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

## SDK
If you want to integrate Privacy Cash into your project, use the [Privacy Cash SDK](https://github.com/Privacy-Cash/privacy-cash-sdk) here.

## Anchor Program
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
   npm run test:sol
   npm run test:spl
   npm run test:mint-checked
   ```

5. Deploy the program to devnet:
   ```bash
   anchor build -- --features devnet
   rm target/deploy/zkcash-keypair.json
   cp zkcash-keypair.json target/deploy/zkcash-keypair.json
   anchor deploy --provider.cluster devnet

   or
   rm target
   anchor build --verifiable
   cp zkcash-keypair.json target/deploy/zkcash-keypair.json
   anchor deploy --verifiable --provider.cluster devnet

   or
   solana program deploy target/deploy/zkcash.so --program-id zkcash-keypair.json --upgrade-authority ./deploy-keypair.json
   ```

6. Deploy to mainnet:
   ```bash
   anchor build --verifiable

   rm target/deploy/zkcash-keypair.json
   cp zkcash-keypair.json target/deploy/zkcash-keypair.json 

   anchor deploy --verifiable --provider.cluster mainnet
   ```

7. Transfer the authority to multisig wallet
   ```bash
   solana program set-upgrade-authority 9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD \
   --new-upgrade-authority AWexibGxNFKTa1b5R5MN4PJr9HWnWRwf8EW9g8cLx3dM \
   --upgrade-authority deploy-keypair.json \
   --skip-new-upgrade-authority-signer-check \
   --url mainnet-beta
   ```

# Program verification
1. Dump onchain program hash
   ```bash
   solana program dump 9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD current_program.so --url mainnet-beta && sha256sum current_program.so
   >> c6f1e5336f2068dc1c1e1c64e92e3d8495b8df79f78011e2620af60aa43090c5  current_program.so
   ```
2. Build a verifiable anchor program based on github commit
   ```bash
   git checkout 549686066e81c5434182f9f85b9296bb636b07e9
   cd anchor
   solana-verify build --base-image solanafoundation/anchor:v0.31.0
   solana-verify get-executable-hash target/deploy/zkcash.so
   >> c6f1e5336f2068dc1c1e1c64e92e3d8495b8df79f78011e2620af60aa43090c5  target/verifiable/zkcash.so
   ```

3. You'll find the hash of onchain program exactly matches the zkcash program generated from commit 549686066e81c5434182f9f85b9296bb636b07e9, which is the commit audited.