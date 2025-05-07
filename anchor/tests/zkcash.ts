import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Zkcash } from "../target/types/zkcash"; // This should be `zkcash` unless the program name is actually "anchor"
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { DEFAULT_HEIGHT, ROOT_HISTORY_SIZE, ZERO_BYTES } from "./lib/constants";
import { getExtDataHash } from "../../scripts/utils/utils";
import { bnToBytes } from "./lib/utils";

describe("zkcash", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  
  const program = anchor.workspace.Zkcash as Program<Zkcash>;

  // Generate keypairs for the accounts needed in the test
  let treeAccountPDA: PublicKey;
  let feeRecipientPDA: PublicKey;
  let treeBump: number;
  let feeRecipientBump: number;
  let authority: anchor.web3.Keypair;
  let recipient: anchor.web3.Keypair;
  let fundingAccount: anchor.web3.Keypair;
  let randomUser: anchor.web3.Keypair; // Random user for signing transactions

  // Initialize variables for tree token account
  let treeTokenAccountPDA: PublicKey;
  let treeTokenBump: number;

  // --- Funding a wallet to use for paying transaction fees ---
  before(async () => {
    // Generate a funding account to pay for transactions
    fundingAccount = anchor.web3.Keypair.generate();
    
    // Airdrop SOL to the funding account
    console.log(`Airdropping SOL to funding account ${fundingAccount.publicKey.toBase58()}...`);
    const airdropSignature = await provider.connection.requestAirdrop(
      fundingAccount.publicKey,
      50 * LAMPORTS_PER_SOL // Airdrop 50 SOL
    );

    // Confirm the transaction
    const latestBlockHash = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature: airdropSignature,
    });

    console.log("Airdrop complete.");

    // Check the balance
    const balance = await provider.connection.getBalance(fundingAccount.publicKey);
    console.log(`Funding account balance: ${balance / LAMPORTS_PER_SOL} SOL`);
    expect(balance).to.be.greaterThan(0);
  });

  // Reset program state before each test
  beforeEach(async () => {
    // Generate a fresh authority keypair for each test (ensuring unique PDAs)
    authority = anchor.web3.Keypair.generate();

    // Transfer enough SOL from funding account to the new authority
    const transferTx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: fundingAccount.publicKey,
        toPubkey: authority.publicKey,
        lamports: 2 * LAMPORTS_PER_SOL, // Increase to 2 SOL to ensure enough for rent
      })
    );
    
    // Send and confirm the transfer transaction
    const transferSignature = await provider.connection.sendTransaction(transferTx, [fundingAccount]);
    await provider.connection.confirmTransaction(transferSignature);
    
    // Verify the authority has received funds
    const authorityBalance = await provider.connection.getBalance(authority.publicKey);
    expect(authorityBalance).to.be.greaterThan(0);
    
    // Generate new recipient keypair for each test
    recipient = anchor.web3.Keypair.generate();
    
    // Fund the recipient with SOL for rent exemption
    const recipientAirdropSignature = await provider.connection.requestAirdrop(recipient.publicKey, 0.5 * LAMPORTS_PER_SOL);
    // Confirm the airdrop
    const latestBlockhash = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      signature: recipientAirdropSignature,
    });
    
    // Calculate the PDA for the tree account with the new authority
    const [treePda, pdaBump] = await PublicKey.findProgramAddressSync(
      [Buffer.from("merkle_tree"), authority.publicKey.toBuffer()],
      program.programId
    );
    treeAccountPDA = treePda;
    treeBump = pdaBump;

    // Calculate the PDA for the fee recipient account with the new authority
    const [feeRecipientPda, feeRecipientPdaBump] = await PublicKey.findProgramAddressSync(
      [Buffer.from("fee_recipient"), authority.publicKey.toBuffer()],
      program.programId
    );
    feeRecipientPDA = feeRecipientPda;
    feeRecipientBump = feeRecipientPdaBump;
    
    // Calculate the PDA for the tree token account with the new authority
    const [treeTokenPda, treeTokenPdaBump] = await PublicKey.findProgramAddressSync(
      [Buffer.from("tree_token"), authority.publicKey.toBuffer()],
      program.programId
    );
    treeTokenAccountPDA = treeTokenPda;
    treeTokenBump = treeTokenPdaBump;
    
    // Initialize a fresh tree account for each test
    try {
      await program.methods
        .initialize()
        .accounts({
          treeAccount: treeAccountPDA,
          feeRecipientAccount: feeRecipientPDA,
          treeTokenAccount: treeTokenAccountPDA,
          authority: authority.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([authority]) // Only authority is a signer
        .rpc();
        
      // Fund the treeTokenAccount with SOL (do this after initialization)
      const treeTokenAirdropSignature = await provider.connection.requestAirdrop(treeTokenAccountPDA, 2 * LAMPORTS_PER_SOL);
      const latestBlockHash2 = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        blockhash: latestBlockHash2.blockhash,
        lastValidBlockHeight: latestBlockHash2.lastValidBlockHeight,
        signature: treeTokenAirdropSignature,
      });
      
      // Fund the feeRecipientAccount with SOL
      const feeRecipientAirdropSignature = await provider.connection.requestAirdrop(feeRecipientPDA, 1 * LAMPORTS_PER_SOL);
      const latestBlockHash3 = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        blockhash: latestBlockHash3.blockhash,
        lastValidBlockHeight: latestBlockHash3.lastValidBlockHeight,
        signature: feeRecipientAirdropSignature,
      });
      
      // Generate a random user for signing transactions
      randomUser = anchor.web3.Keypair.generate();
      
      // Fund the random user with SOL
      const randomUserAirdropSignature = await provider.connection.requestAirdrop(randomUser.publicKey, 1 * LAMPORTS_PER_SOL);
      const latestBlockHash4 = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        blockhash: latestBlockHash4.blockhash,
        lastValidBlockHeight: latestBlockHash4.lastValidBlockHeight,
        signature: randomUserAirdropSignature,
      });
      
      // Check balances after funding
      const treeTokenBalance = await provider.connection.getBalance(treeTokenAccountPDA);
      const feeRecipientBalance = await provider.connection.getBalance(feeRecipientPDA);
      const recipientBalance = await provider.connection.getBalance(recipient.publicKey);
      const randomUserBalance = await provider.connection.getBalance(randomUser.publicKey);
      
      // Verify the initialization was successful
      const merkleTreeAccount = await program.account.merkleTreeAccount.fetch(treeAccountPDA);
      expect(merkleTreeAccount.authority.equals(authority.publicKey)).to.be.true;
      expect(merkleTreeAccount.nextIndex.toString()).to.equal("0");
      expect(merkleTreeAccount.rootIndex.toString()).to.equal("0");
      expect(merkleTreeAccount.rootHistory.length).to.equal(ROOT_HISTORY_SIZE);
      expect(merkleTreeAccount.root).to.deep.equal(ZERO_BYTES[DEFAULT_HEIGHT]);

      // Verify the fee recipient account was initialized correctly
      const feeRecipientAccount = await program.account.feeRecipientAccount.fetch(feeRecipientPDA);
      expect(feeRecipientAccount.authority.equals(authority.publicKey)).to.be.true;
      expect(feeRecipientAccount.bump).to.equal(feeRecipientBump);
    } catch (error) {
      console.error("Error initializing accounts:", error);
      // Get more detailed error information if available
      if ('logs' in error) {
        console.error("Error logs:", error.logs);
      }
      throw error;
    }
  });

  it("Can execute transact instruction for correct input, and negative extAmount", async () => {
    // Create a sample ExtData object with original values
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(-100), // Negative ext amount (withdrawal)
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(100), // Fee
      tokenMint: new PublicKey("11111111111111111111111111111111")
    };

    // Calculate the hash correctly using our utility
    const calculatedExtDataHash = getExtDataHash(extData);
    
    // Create a Proof object with the correctly calculated hash
    const proof = {
      proof: Buffer.from("mockProofData"),
      root: ZERO_BYTES[DEFAULT_HEIGHT],
      inputNullifiers: [
        Array(32).fill(1),
        Array(32).fill(2)
      ],
      outputCommitments: [
        Array(32).fill(3),
        Array(32).fill(4)
      ],
      publicAmount: bnToBytes(new anchor.BN(200)), // Public amount
      extDataHash: Array.from(calculatedExtDataHash)
    };
    
    // Execute the transaction without pre-instructions
    const tx = await program.methods
      .transact(proof, extData)
      .accounts({
        treeAccount: treeAccountPDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: feeRecipientPDA,
        treeTokenAccount: treeTokenAccountPDA,
        authority: authority.publicKey,
        signer: randomUser.publicKey, // Use random user as signer
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser]) // Random user signs the transaction
      .rpc();
    
    expect(tx).to.be.a('string');
  });

  it("Can execute transact instruction for correct input, and positive extAmount", async () => {
    // Create a sample ExtData object with original values
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(200), // Positive ext amount (deposit)
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(50), // Fee
      tokenMint: new PublicKey("11111111111111111111111111111111")
    };

    // Calculate the hash correctly using our utility
    const calculatedExtDataHash = getExtDataHash(extData);
    
    // Create a Proof object with the correctly calculated hash
    const proof = {
      proof: Buffer.from("mockProofData"),
      root: ZERO_BYTES[DEFAULT_HEIGHT],
      inputNullifiers: [
        Array(32).fill(1),
        Array(32).fill(2)
      ],
      outputCommitments: [
        Array(32).fill(3),
        Array(32).fill(4)
      ],
      publicAmount: bnToBytes(new anchor.BN(150)), // Public amount
      extDataHash: Array.from(calculatedExtDataHash)
    };

    // Execute the transaction without pre-instructions
    const tx = await program.methods
      .transact(proof, extData)
      .accounts({
        treeAccount: treeAccountPDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: feeRecipientPDA,
        treeTokenAccount: treeTokenAccountPDA,
        authority: authority.publicKey,
        signer: randomUser.publicKey, // Use random user as signer
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser]) // Random user signs the transaction
      .rpc();
    
    expect(tx).to.be.a('string');
  });

  it("Fails transact instruction for the wrong extDataHash", async () => {
    // Create a sample ExtData object
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(-100),
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(100),
      tokenMint: new PublicKey("11111111111111111111111111111111")
    };

    // Create a different ExtData to generate a different hash
    const modifiedExtData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(100), // Different amount (positive instead of negative)
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(100),
      tokenMint: new PublicKey("11111111111111111111111111111111")
    };

    // Calculate the hash using the modified data
    const incorrectExtDataHash = getExtDataHash(modifiedExtData);
    
    // Create a Proof object with the incorrect hash
    const proof = {
      proof: Buffer.from("mockProofData"),
      root: ZERO_BYTES[DEFAULT_HEIGHT],
      inputNullifiers: [
        Array(32).fill(1),
        Array(32).fill(2)
      ],
      outputCommitments: [
        Array(32).fill(3),
        Array(32).fill(4)
      ],
      publicAmount: bnToBytes(new anchor.BN(200)),
      extDataHash: Array.from(incorrectExtDataHash)
    };

    try {
      // Execute the transaction - this should fail because the hash doesn't match
      await program.methods
        .transact(proof, extData)
        .accounts({
          treeAccount: treeAccountPDA,
          recipient: recipient.publicKey,
          feeRecipientAccount: feeRecipientPDA,
          treeTokenAccount: treeTokenAccountPDA,
          authority: authority.publicKey,
          signer: randomUser.publicKey, // Use random user as signer
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([randomUser]) // Random user signs the transaction
        .rpc();
      
      // If we reach here, the test should fail because the transaction should have thrown an error
      expect.fail("Transaction should have failed due to invalid extDataHash but succeeded");
    } catch (error) {
      // Check if the error is an AnchorError with the expected error code
      if (error instanceof anchor.AnchorError) {
        expect(error.error.errorCode.number).to.equal(6001); // ExtDataHashMismatch error code
        expect(error.error.errorMessage).to.equal("External data hash does not match the one in the proof");
      } else {
        // If it's not an AnchorError or has the wrong error code, fail the test
        console.error("Unexpected error:", error);
        throw error;
      }
    }
  });

  it("Fails transact instruction for an unknown root", async () => {
    // Create a sample ExtData object
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(-100),
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(100),
      tokenMint: new PublicKey("11111111111111111111111111111111")
    };

    // Calculate the correct extDataHash
    const calculatedExtDataHash = getExtDataHash(extData);
    
    // Create an invalid root (not in the tree's history)
    const invalidRoot = Array(32).fill(123); // Different from any known root
    
    // Create a Proof object with the invalid root but correct hash
    const proof = {
      proof: Buffer.from("mockProofData"),
      root: invalidRoot,
      inputNullifiers: [
        Array(32).fill(1),
        Array(32).fill(2)
      ],
      outputCommitments: [
        Array(32).fill(3),
        Array(32).fill(4)
      ],
      publicAmount: bnToBytes(new anchor.BN(200)),
      extDataHash: Array.from(calculatedExtDataHash)
    };

    try {
      // Execute the transaction - this should fail because the root is unknown
      await program.methods
        .transact(proof, extData)
        .accounts({
          treeAccount: treeAccountPDA,
          recipient: recipient.publicKey,
          feeRecipientAccount: feeRecipientPDA,
          treeTokenAccount: treeTokenAccountPDA,
          authority: authority.publicKey,
          signer: randomUser.publicKey, // Use random user as signer
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([randomUser]) // Random user signs the transaction
        .rpc();
      
      // If we reach here, the test should fail because the transaction should have thrown an error
      expect.fail("Transaction should have failed due to unknown root but succeeded");
    } catch (error) {
      // Check if the error is an AnchorError with the expected error code
      if (error instanceof anchor.AnchorError) {
        expect(error.error.errorCode.number).to.equal(6002); // UnknownRoot error code
        expect(error.error.errorMessage).to.equal("Root is not known in the tree");
      } else {
        // If it's not an AnchorError or has the wrong error code, fail the test
        console.error("Unexpected error:", error);
        throw error;
      }
    }
  });

  it("Fails transact instruction for zero root", async () => {
    // Create a sample ExtData object
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(-100),
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(100),
      tokenMint: new PublicKey("11111111111111111111111111111111")
    };

    // Calculate the correct extDataHash
    const calculatedExtDataHash = getExtDataHash(extData);
    
    const zeroRoot = Array(32).fill(0);
    
    // Create a Proof object with the invalid root but correct hash
    const proof = {
      proof: Buffer.from("mockProofData"),
      root: zeroRoot,
      inputNullifiers: [
        Array(32).fill(1),
        Array(32).fill(2)
      ],
      outputCommitments: [
        Array(32).fill(3),
        Array(32).fill(4)
      ],
      publicAmount: bnToBytes(new anchor.BN(200)),
      extDataHash: Array.from(calculatedExtDataHash)
    };

    try {
      // Execute the transaction - this should fail because the root is unknown
      await program.methods
        .transact(proof, extData)
        .accounts({
          treeAccount: treeAccountPDA,
          recipient: recipient.publicKey,
          feeRecipientAccount: feeRecipientPDA,
          treeTokenAccount: treeTokenAccountPDA,
          authority: authority.publicKey,
          signer: randomUser.publicKey, // Use random user as signer
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([randomUser]) // Random user signs the transaction
        .rpc();
      
      // If we reach here, the test should fail because the transaction should have thrown an error
      expect.fail("Transaction should have failed due to unknown root but succeeded");
    } catch (error) {
      // Check if the error is an AnchorError with the expected error code
      if (error instanceof anchor.AnchorError) {
        expect(error.error.errorCode.number).to.equal(6002); // UnknownRoot error code
        expect(error.error.errorMessage).to.equal("Root is not known in the tree");
      } else {
        // If it's not an AnchorError or has the wrong error code, fail the test
        console.error("Unexpected error:", error);
        throw error;
      }
    }
  });

  it("Transact succeeds with the correct root", async () => {
    // Fetch the Merkle tree account to get the current root
    const treeAccountData = await program.account.merkleTreeAccount.fetch(treeAccountPDA);

    // This should now pass because we're using a fresh tree account for each test
    expect(treeAccountData.root).to.deep.equal(ZERO_BYTES[DEFAULT_HEIGHT]);
    
    // Test that a transaction with the initial root works
    // Using original values
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(-100), // Original value
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(100), // Original value
      tokenMint: new PublicKey("11111111111111111111111111111111")
    };

    const calculatedExtDataHash = getExtDataHash(extData);
    
    // Create a Proof with the current valid root (initial root)
    const validProof = {
      proof: Buffer.from("mockProofData"),
      root: Array.from(treeAccountData.root), // Use the current valid root
      inputNullifiers: [
        Array(32).fill(1),
        Array(32).fill(2)
      ],
      outputCommitments: [
        Array(32).fill(3),
        Array(32).fill(4)
      ],
      publicAmount: bnToBytes(new anchor.BN(200)), // Original value
      extDataHash: Array.from(calculatedExtDataHash)
    };
    
    // This transaction should succeed because the root is valid
    const transactTx = await program.methods
      .transact(validProof, extData)
      .accounts({
        treeAccount: treeAccountPDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: feeRecipientPDA,
        treeTokenAccount: treeTokenAccountPDA,
        authority: authority.publicKey,
        signer: randomUser.publicKey, // Use random user as signer
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser]) // Random user signs the transaction
      .rpc();
    
    expect(transactTx).to.be.a('string');
  });

  it("Transact succeeds after the second root update", async () => {
    // First transaction to update the root - use original values
    const firstExtData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(-100), // Original value
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(100), // Original value
      tokenMint: new PublicKey("11111111111111111111111111111111")
    };

    const firstExtDataHash = getExtDataHash(firstExtData);
    
    const firstProof = {
      proof: Buffer.from("mockProofData"),
      root: ZERO_BYTES[DEFAULT_HEIGHT], // Initial root
      inputNullifiers: [
        Array(32).fill(1),
        Array(32).fill(2)
      ],
      outputCommitments: [
        Array(32).fill(3),
        Array(32).fill(4)
      ],
      publicAmount: bnToBytes(new anchor.BN(200)), // Original value
      extDataHash: Array.from(firstExtDataHash)
    };
    
    // Note: No need for further funding as we fund in beforeEach
    
    // This transaction should succeed with the initial root
    await program.methods
      .transact(firstProof, firstExtData)
      .accounts({
        treeAccount: treeAccountPDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: feeRecipientPDA,
        treeTokenAccount: treeTokenAccountPDA,
        authority: authority.publicKey,
        signer: randomUser.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .rpc();
    
    // Fetch the updated root
    const treeAccountData = await program.account.merkleTreeAccount.fetch(treeAccountPDA);
    
    // Second transaction with the updated root - use original values
    const secondExtData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(-100), // Original value
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(100), // Original value
      tokenMint: new PublicKey("11111111111111111111111111111111")
    };

    const calculatedSecondExtDataHash = getExtDataHash(secondExtData);

    const secondValidProof = {
      proof: Buffer.from("mockProofData"),
      root: Array.from(treeAccountData.root), // Use the updated root
      inputNullifiers: [
        Array(32).fill(5), // Different nullifiers
        Array(32).fill(6)
      ],
      outputCommitments: [
        Array(32).fill(7), // Different commitments
        Array(32).fill(8)
      ],
      publicAmount: bnToBytes(new anchor.BN(200)), // Original value
      extDataHash: Array.from(calculatedSecondExtDataHash)
    };
    
    // Note: No need for further funding as we fund in beforeEach
    
    // This transaction should succeed because the root is valid
    const secondTransactTx = await program.methods
      .transact(secondValidProof, secondExtData)
      .accounts({
        treeAccount: treeAccountPDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: feeRecipientPDA,
        treeTokenAccount: treeTokenAccountPDA,
        authority: authority.publicKey,
        signer: randomUser.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .rpc();
    
    expect(secondTransactTx).to.be.a('string');
  });

  it("Succeeds with valid external amount and fee (withdrawal)", async () => {
    // For withdrawal test, use original values
    const extAmount = new anchor.BN(-100);
    const fee = new anchor.BN(100);
    const publicAmount = new anchor.BN(200);
    
    const extData = {
      recipient: recipient.publicKey,
      extAmount: extAmount,
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: fee,
      tokenMint: new PublicKey("11111111111111111111111111111111")
    };

    const calculatedExtDataHash = getExtDataHash(extData);
    
    const validProof = {
      proof: Buffer.from("mockProofData"),
      root: ZERO_BYTES[DEFAULT_HEIGHT],
      inputNullifiers: [
        Array(32).fill(1),
        Array(32).fill(2)
      ],
      outputCommitments: [
        Array(32).fill(3),
        Array(32).fill(4)
      ],
      publicAmount: bnToBytes(publicAmount),
      extDataHash: Array.from(calculatedExtDataHash)
    };

    // Transaction should succeed with original amounts
    const tx = await program.methods
      .transact(validProof, extData)
      .accounts({
        treeAccount: treeAccountPDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: feeRecipientPDA,
        treeTokenAccount: treeTokenAccountPDA,
        authority: authority.publicKey,
        signer: randomUser.publicKey, // Use random user as signer
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser]) // Random user signs the transaction
      .rpc();
    
    expect(tx).to.be.a('string');
  });

  it("Succeeds with valid external amount and fee (deposit)", async () => {
    // For deposit test, use original values
    const extAmount = new anchor.BN(200);
    const fee = new anchor.BN(50);
    const publicAmount = new anchor.BN(150);
    
    const extData = {
      recipient: recipient.publicKey,
      extAmount: extAmount,
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: fee,
      tokenMint: new PublicKey("11111111111111111111111111111111")
    };

    const calculatedExtDataHash = getExtDataHash(extData);
    
    const validProof = {
      proof: Buffer.from("mockProofData"),
      root: ZERO_BYTES[DEFAULT_HEIGHT],
      inputNullifiers: [
        Array(32).fill(1),
        Array(32).fill(2)
      ],
      outputCommitments: [
        Array(32).fill(3),
        Array(32).fill(4)
      ],
      publicAmount: bnToBytes(publicAmount),
      extDataHash: Array.from(calculatedExtDataHash)
    };

    // Transaction should succeed with original amounts
    const tx = await program.methods
      .transact(validProof, extData)
      .accounts({
        treeAccount: treeAccountPDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: feeRecipientPDA,
        treeTokenAccount: treeTokenAccountPDA,
        authority: authority.publicKey,
        signer: randomUser.publicKey, // Use random user as signer
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser]) // Random user signs the transaction
      .rpc();
    
    expect(tx).to.be.a('string');
  });

  it("Succeeds with zero fee", async () => {
    // Case with zero fee but non-zero external amount
    const extAmount = new anchor.BN(-100);
    const fee = new anchor.BN(0);
    const publicAmount = new anchor.BN(100);
    
    const extData = {
      recipient: recipient.publicKey,
      extAmount: extAmount,
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: fee,
      tokenMint: new PublicKey("11111111111111111111111111111111")
    };

    const calculatedExtDataHash = getExtDataHash(extData);
    
    const validProof = {
      proof: Buffer.from("mockProofData"),
      root: ZERO_BYTES[DEFAULT_HEIGHT],
      inputNullifiers: [
        Array(32).fill(1),
        Array(32).fill(2)
      ],
      outputCommitments: [
        Array(32).fill(3),
        Array(32).fill(4)
      ],
      publicAmount: bnToBytes(publicAmount),
      extDataHash: Array.from(calculatedExtDataHash)
    };

    // Transaction should succeed with zero fee
    const tx = await program.methods
      .transact(validProof, extData)
      .accounts({
        treeAccount: treeAccountPDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: feeRecipientPDA,
        treeTokenAccount: treeTokenAccountPDA,
        authority: authority.publicKey,
        signer: randomUser.publicKey, // Use random user as signer
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser]) // Random user signs the transaction
      .rpc();
    
    expect(tx).to.be.a('string');
  });

  it("Fails with invalid external amount and public amount relation (withdrawal)", async () => {
    // For invalid withdrawal: ext_amount is negative, fee is positive, 
    // but |ext_amount| + fee != public_amount
    const extAmount = new anchor.BN(-100);
    const fee = new anchor.BN(50);
    const publicAmount = new anchor.BN(200); // Should be 150 but we set 200 to cause failure
    
    const extData = {
      recipient: recipient.publicKey,
      extAmount: extAmount,
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: fee,
      tokenMint: new PublicKey("11111111111111111111111111111111")
    };

    const calculatedExtDataHash = getExtDataHash(extData);
    
    const invalidProof = {
      proof: Buffer.from("mockProofData"),
      root: ZERO_BYTES[DEFAULT_HEIGHT],
      inputNullifiers: [
        Array(32).fill(1),
        Array(32).fill(2)
      ],
      outputCommitments: [
        Array(32).fill(3),
        Array(32).fill(4)
      ],
      publicAmount: bnToBytes(publicAmount),
      extDataHash: Array.from(calculatedExtDataHash)
    };

    try {
      // Transaction should fail due to invalid amount relation
      await program.methods
        .transact(invalidProof, extData)
        .accounts({
          treeAccount: treeAccountPDA,
          recipient: recipient.publicKey,
          feeRecipientAccount: feeRecipientPDA,
          treeTokenAccount: treeTokenAccountPDA,
          authority: authority.publicKey,
          signer: randomUser.publicKey, // Use random user as signer
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([randomUser]) // Random user signs the transaction
        .rpc();
      
      // If we reach here, the test should fail because the transaction should have thrown an error
      expect.fail("Transaction should have failed due to invalid amount relation but succeeded");
    } catch (error) {
      // Check if the error is an AnchorError with the expected error code
      if (error instanceof anchor.AnchorError) {
        expect(error.error.errorCode.number).to.equal(6003);
        expect(error.error.errorMessage).to.equal("Public amount is invalid");
      } else {
        // If it's not an AnchorError or has the wrong error code, fail the test
        console.error("Unexpected error:", error);
        throw error;
      }
    }
  });

  it("Fails with invalid external amount and public amount relation (deposit)", async () => {
    // For invalid deposit: ext_amount is positive, fee is positive, 
    // but ext_amount - fee != public_amount
    const extAmount = new anchor.BN(200);
    const fee = new anchor.BN(50);
    const publicAmount = new anchor.BN(100); // Should be 150 but we set 100 to cause failure
    
    const extData = {
      recipient: recipient.publicKey,
      extAmount: extAmount,
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: fee,
      tokenMint: new PublicKey("11111111111111111111111111111111")
    };

    const calculatedExtDataHash = getExtDataHash(extData);
    
    const invalidProof = {
      proof: Buffer.from("mockProofData"),
      root: ZERO_BYTES[DEFAULT_HEIGHT],
      inputNullifiers: [
        Array(32).fill(1),
        Array(32).fill(2)
      ],
      outputCommitments: [
        Array(32).fill(3),
        Array(32).fill(4)
      ],
      publicAmount: bnToBytes(publicAmount),
      extDataHash: Array.from(calculatedExtDataHash)
    };

    try {
      // Transaction should fail due to invalid amount relation
      await program.methods
        .transact(invalidProof, extData)
        .accounts({
          treeAccount: treeAccountPDA,
          recipient: recipient.publicKey,
          feeRecipientAccount: feeRecipientPDA,
          treeTokenAccount: treeTokenAccountPDA,
          authority: authority.publicKey,
          signer: randomUser.publicKey, // Use random user as signer
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([randomUser]) // Random user signs the transaction
        .rpc();
      
      // If we reach here, the test should fail because the transaction should have thrown an error
      expect.fail("Transaction should have failed due to invalid amount relation but succeeded");
    } catch (error) {
      // Check if the error is an AnchorError with the expected error code
      if (error instanceof anchor.AnchorError) {
        expect(error.error.errorCode.number).to.equal(6003);
        expect(error.error.errorMessage).to.equal("Public amount is invalid");
      } else {
        // If it's not an AnchorError or has the wrong error code, fail the test
        console.error("Unexpected error:", error);
        throw error;
      }
    }
  });

  it("Fails with negative fee, as hash check isn't valid for negative fee", async () => {
    // Case with negative fee, which should not be allowed
    const extAmount = new anchor.BN(-100);
    const fee = new anchor.BN(-10); // Negative fee should cause failure
    const publicAmount = new anchor.BN(90); // We're intentionally using the wrong formula to test fee validation
    
    const extData = {
      recipient: recipient.publicKey,
      extAmount: extAmount,
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: fee,
      tokenMint: new PublicKey("11111111111111111111111111111111")
    };

    const calculatedExtDataHash = getExtDataHash(extData);
    
    const invalidProof = {
      proof: Buffer.from("mockProofData"),
      root: ZERO_BYTES[DEFAULT_HEIGHT],
      inputNullifiers: [
        Array(32).fill(1),
        Array(32).fill(2)
      ],
      outputCommitments: [
        Array(32).fill(3),
        Array(32).fill(4)
      ],
      publicAmount: bnToBytes(publicAmount),
      extDataHash: Array.from(calculatedExtDataHash)
    };

    try {
      // Transaction should fail due to negative fee
      await program.methods
        .transact(invalidProof, extData)
        .accounts({
          treeAccount: treeAccountPDA,
          recipient: recipient.publicKey,
          feeRecipientAccount: feeRecipientPDA,
          treeTokenAccount: treeTokenAccountPDA,
          authority: authority.publicKey,
          signer: randomUser.publicKey, // Use random user as signer
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([randomUser]) // Random user signs the transaction
        .rpc();
      
      // If we reach here, the test should fail because the transaction should have thrown an error
      expect.fail("Transaction should have failed due to negative fee but succeeded");
    } catch (error) {
      // Check if the error is an AnchorError with the expected error code
      if (error instanceof anchor.AnchorError) {
        expect(error.error.errorCode.number).to.equal(6001);
        expect(error.error.errorMessage).to.equal("External data hash does not match the one in the proof");
      } else {
        // If it's not an AnchorError or has the wrong error code, fail the test
        console.error("Unexpected error:", error);
        throw error;
      }
    }
  });

  it("Succeeds with correct authority", async () => {
    // Use the correct authority with original values
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(-100), // Original value
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(100), // Original value
      tokenMint: new PublicKey("11111111111111111111111111111111")
    };

    const calculatedExtDataHash = getExtDataHash(extData);

    const validProof = {
      proof: Buffer.from("mockProofData"),
      root: ZERO_BYTES[DEFAULT_HEIGHT],
      inputNullifiers: [
        Array(32).fill(1),
        Array(32).fill(2)
      ],
      outputCommitments: [
        Array(32).fill(3),
        Array(32).fill(4)
      ],
      publicAmount: bnToBytes(new anchor.BN(200)), // Original value
      extDataHash: Array.from(calculatedExtDataHash)
    };

    // This transaction should succeed with the correct authority
    const tx = await program.methods
      .transact(validProof, extData)
      .accounts({
        treeAccount: treeAccountPDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: feeRecipientPDA,
        treeTokenAccount: treeTokenAccountPDA,
        authority: authority.publicKey,
        signer: randomUser.publicKey, // Use random user as signer
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser]) // Random user signs the transaction
      .rpc();

    expect(tx).to.be.a('string');
  });

  it("Fails with mismatched tree account authority", async () => {
    // Create a different authority
    const wrongAuthority = anchor.web3.Keypair.generate();
    
    // Fund the wrong authority
    const transferTx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: fundingAccount.publicKey,
        toPubkey: wrongAuthority.publicKey,
        lamports: 1 * LAMPORTS_PER_SOL, // Increase to 1 SOL to ensure enough for rent
      })
    );
    
    // Send and confirm the transfer transaction
    const transferSignature = await provider.connection.sendTransaction(transferTx, [fundingAccount]);
    await provider.connection.confirmTransaction(transferSignature);
    
    // Verify the wrong authority has received funds
    const wrongBalance = await provider.connection.getBalance(wrongAuthority.publicKey);
    expect(wrongBalance).to.be.greaterThan(0);
    
    // Create PDAs for wrong authority
    const [wrongTreePDA, _wrongTreeBump] = await PublicKey.findProgramAddressSync(
      [Buffer.from("merkle_tree"), wrongAuthority.publicKey.toBuffer()],
      program.programId
    );
    
    const [wrongFeePDA, _wrongFeeBump] = await PublicKey.findProgramAddressSync(
      [Buffer.from("fee_recipient"), wrongAuthority.publicKey.toBuffer()],
      program.programId
    );
    
    const [wrongTreeTokenPDA, _wrongTreeTokenBump] = await PublicKey.findProgramAddressSync(
      [Buffer.from("tree_token"), wrongAuthority.publicKey.toBuffer()],
      program.programId
    );
    
    // Initialize accounts with the wrong authority
    await program.methods
      .initialize()
      .accounts({
        treeAccount: wrongTreePDA,
        feeRecipientAccount: wrongFeePDA,
        treeTokenAccount: wrongTreeTokenPDA,
        authority: wrongAuthority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([wrongAuthority])
      .rpc();
      
    // Verify the initialization was successful
    const wrongTreeAccount = await program.account.merkleTreeAccount.fetch(wrongTreePDA);
    expect(wrongTreeAccount.authority.equals(wrongAuthority.publicKey)).to.be.true;
    
    // Now try to execute transaction with mismatched authorities
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(-100), // Restore the original negative extAmount
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(100), // Restore the original fee value
      tokenMint: new PublicKey("11111111111111111111111111111111")
    };
    
    const calculatedExtDataHash = getExtDataHash(extData);
    
    const validProof = {
      proof: Buffer.from("mockProofData"),
      root: ZERO_BYTES[DEFAULT_HEIGHT],
      inputNullifiers: [
        Array(32).fill(1),
        Array(32).fill(2)
      ],
      outputCommitments: [
        Array(32).fill(3),
        Array(32).fill(4)
      ],
      publicAmount: bnToBytes(new anchor.BN(200)), // Restore the original non-zero public amount
      extDataHash: Array.from(calculatedExtDataHash)
    };
    
    try {
      // Try to use wrongTreePDA but with original authority - should fail
      await program.methods
        .transact(validProof, extData)
        .accounts({
          treeAccount: wrongTreePDA,
          recipient: recipient.publicKey,
          feeRecipientAccount: feeRecipientPDA,
          treeTokenAccount: treeTokenAccountPDA,
          authority: authority.publicKey, // This doesn't match wrongTreePDA's authority
          signer: randomUser.publicKey, // Use random user as signer
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([randomUser]) // Random user signs the transaction
        .rpc();
      
      expect.fail("Transaction should have failed due to mismatched tree account authority but succeeded");
    } catch (error) {
      if (error instanceof anchor.AnchorError) {
        expect(error.error.errorCode.number).to.equal(2006); // Seeds constraint was violated error code
        expect(error.error.errorMessage).to.equal("A seeds constraint was violated");
      } else {
        console.error("Unexpected error:", error);
        throw error;
      }
    }
  });

  it("Fails with mismatched fee recipient account authority", async () => {
    // Create a different authority
    const wrongAuthority = anchor.web3.Keypair.generate();
    
    // Fund the wrong authority
    const transferTx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: fundingAccount.publicKey,
        toPubkey: wrongAuthority.publicKey,
        lamports: 1 * LAMPORTS_PER_SOL, // Increase to 1 SOL to ensure enough for rent
      })
    );
    
    // Send and confirm the transfer transaction
    const transferSignature = await provider.connection.sendTransaction(transferTx, [fundingAccount]);
    await provider.connection.confirmTransaction(transferSignature);
    
    // Verify the wrong authority has received funds
    const wrongBalance = await provider.connection.getBalance(wrongAuthority.publicKey);
    expect(wrongBalance).to.be.greaterThan(0);
    
    // Create PDAs for wrong authority
    const [wrongTreePDA, _wrongTreeBump] = await PublicKey.findProgramAddressSync(
      [Buffer.from("merkle_tree"), wrongAuthority.publicKey.toBuffer()],
      program.programId
    );
    
    const [wrongFeePDA, _wrongFeeBump] = await PublicKey.findProgramAddressSync(
      [Buffer.from("fee_recipient"), wrongAuthority.publicKey.toBuffer()],
      program.programId
    );
    
    const [wrongTreeTokenPDA, _wrongTreeTokenBump] = await PublicKey.findProgramAddressSync(
      [Buffer.from("tree_token"), wrongAuthority.publicKey.toBuffer()],
      program.programId
    );
    
    // Initialize accounts with the wrong authority
    await program.methods
      .initialize()
      .accounts({
        treeAccount: wrongTreePDA,
        feeRecipientAccount: wrongFeePDA,
        treeTokenAccount: wrongTreeTokenPDA,
        authority: wrongAuthority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([wrongAuthority])
      .rpc();
      
    // Verify the initialization was successful
    const wrongFeeAccount = await program.account.feeRecipientAccount.fetch(wrongFeePDA);
    expect(wrongFeeAccount.authority.equals(wrongAuthority.publicKey)).to.be.true;
    
    // Now try to execute transaction with mismatched authorities
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(-100), // Restore the original negative extAmount
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(100), // Restore the original fee value
      tokenMint: new PublicKey("11111111111111111111111111111111")
    };
    
    const calculatedExtDataHash = getExtDataHash(extData);
    
    const validProof = {
      proof: Buffer.from("mockProofData"),
      root: ZERO_BYTES[DEFAULT_HEIGHT],
      inputNullifiers: [
        Array(32).fill(1),
        Array(32).fill(2)
      ],
      outputCommitments: [
        Array(32).fill(3),
        Array(32).fill(4)
      ],
      publicAmount: bnToBytes(new anchor.BN(200)), // Restore the original non-zero public amount
      extDataHash: Array.from(calculatedExtDataHash)
    };
    
    try {
      // Try to use wrongFeePDA but with original authority - should fail
      await program.methods
        .transact(validProof, extData)
        .accounts({
          treeAccount: treeAccountPDA,
          recipient: recipient.publicKey,
          feeRecipientAccount: wrongFeePDA,
          treeTokenAccount: treeTokenAccountPDA,
          authority: authority.publicKey, // This doesn't match wrongFeePDA's authority
          signer: randomUser.publicKey, // Use random user as signer
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([randomUser]) // Random user signs the transaction
        .rpc();
      
      expect.fail("Transaction should have failed due to mismatched fee recipient account authority but succeeded");
    } catch (error) {
      if (error instanceof anchor.AnchorError) {
        expect(error.error.errorCode.number).to.equal(2006); // Seeds constraint was violated error code
        expect(error.error.errorMessage).to.equal("A seeds constraint was violated");
      } else {
        console.error("Unexpected error:", error);
        throw error;
      }
    }
  });

  it("Succeeds with explicitly matching authority for both accounts", async () => {
    // Create an alternative authority to emphasize the matching requirement
    const matchingAuthority = anchor.web3.Keypair.generate();
    
    // Fund the matching authority
    const transferTx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: fundingAccount.publicKey,
        toPubkey: matchingAuthority.publicKey,
        lamports: 1 * LAMPORTS_PER_SOL,
      })
    );
    
    // Send and confirm the transfer transaction
    const transferSignature = await provider.connection.sendTransaction(transferTx, [fundingAccount]);
    await provider.connection.confirmTransaction(transferSignature);
    
    // Verify the matching authority has received funds
    const matchingBalance = await provider.connection.getBalance(matchingAuthority.publicKey);
    expect(matchingBalance).to.be.greaterThan(0);
    
    // Calculate the PDAs for matching authority
    const [matchingTreePDA, matchingTreeBump] = await PublicKey.findProgramAddressSync(
      [Buffer.from("merkle_tree"), matchingAuthority.publicKey.toBuffer()],
      program.programId
    );
    
    const [matchingFeePDA, matchingFeeBump] = await PublicKey.findProgramAddressSync(
      [Buffer.from("fee_recipient"), matchingAuthority.publicKey.toBuffer()],
      program.programId
    );
    
    const [matchingTreeTokenPDA, matchingTreeTokenBump] = await PublicKey.findProgramAddressSync(
      [Buffer.from("tree_token"), matchingAuthority.publicKey.toBuffer()],
      program.programId
    );
    
    // Initialize accounts with the matching authority
    await program.methods
      .initialize()
      .accounts({
        treeAccount: matchingTreePDA,
        feeRecipientAccount: matchingFeePDA,
        treeTokenAccount: matchingTreeTokenPDA,
        authority: matchingAuthority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([matchingAuthority])
      .rpc();
      
    // Verify the initialization was successful
    const matchingTreeAccount = await program.account.merkleTreeAccount.fetch(matchingTreePDA);
    expect(matchingTreeAccount.authority.equals(matchingAuthority.publicKey)).to.be.true;
    
    const matchingFeeAccount = await program.account.feeRecipientAccount.fetch(matchingFeePDA);
    expect(matchingFeeAccount.authority.equals(matchingAuthority.publicKey)).to.be.true;
    
    // Generate a new random user specifically for this test to be clear
    const testRandomUser = anchor.web3.Keypair.generate();
    
    // Fund this test's random user
    const testRandomUserAirdropSignature = await provider.connection.requestAirdrop(testRandomUser.publicKey, 1 * LAMPORTS_PER_SOL);
    const randomUserLatestBlockHash = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
      blockhash: randomUserLatestBlockHash.blockhash,
      lastValidBlockHeight: randomUserLatestBlockHash.lastValidBlockHeight,
      signature: testRandomUserAirdropSignature,
    });
    
    // Now execute transaction with explicitly matching authorities
    // Using original values to test real behavior
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(-100), // Original value
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(100), // Original value
      tokenMint: new PublicKey("11111111111111111111111111111111")
    };
    
    const calculatedExtDataHash = getExtDataHash(extData);
    
    const validProof = {
      proof: Buffer.from("mockProofData"),
      root: ZERO_BYTES[DEFAULT_HEIGHT],
      inputNullifiers: [
        Array(32).fill(1),
        Array(32).fill(2)
      ],
      outputCommitments: [
        Array(32).fill(3),
        Array(32).fill(4)
      ],
      publicAmount: bnToBytes(new anchor.BN(200)), // Original value
      extDataHash: Array.from(calculatedExtDataHash)
    };
    
    // Fund matching tree token account explicitly
    const matchingTreeTokenBalance = await provider.connection.getBalance(matchingTreeTokenPDA);
    if (matchingTreeTokenBalance < 1 * LAMPORTS_PER_SOL) {
      const matchingTreeTokenAirdropSignature = await provider.connection.requestAirdrop(matchingTreeTokenPDA, 2 * LAMPORTS_PER_SOL);
      const latestBlockHash4 = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        blockhash: latestBlockHash4.blockhash,
        lastValidBlockHeight: latestBlockHash4.lastValidBlockHeight,
        signature: matchingTreeTokenAirdropSignature,
      });
    }
    
    // This transaction should succeed with the matching authority for both accounts
    const tx = await program.methods
      .transact(validProof, extData)
      .accounts({
        treeAccount: matchingTreePDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: matchingFeePDA,
        treeTokenAccount: matchingTreeTokenPDA,
        authority: matchingAuthority.publicKey, // Explicitly matching authority
        signer: testRandomUser.publicKey, // Random user as signer, not the authority
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([testRandomUser]) // Random user signs the transaction
      .rpc();
    
    expect(tx).to.be.a("string");
    
    // Additional assertion to emphasize that the transaction succeeded
    // Fetch the tree account to verify it was updated after the transaction
    const updatedTreeAccount = await program.account.merkleTreeAccount.fetch(matchingTreePDA);
    expect(updatedTreeAccount.nextIndex.toString()).to.equal("2"); // Should be 2 because we appended 2 output commitments
  });

  // Add new tests with original values
  it("Can execute transact instruction with correct input and zero external amount", async () => {
    // Create a sample ExtData object with zero ext_amount but properly set public amount
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(0),  // Zero external amount - this is intentional for this test
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(0),  // Zero fee - this is intentional for this test
      tokenMint: new PublicKey("11111111111111111111111111111111")
    };

    // Calculate the hash correctly using our utility
    const calculatedExtDataHash = getExtDataHash(extData);
    
    // Create a Proof object with the correctly calculated hash
    const proof = {
      proof: Buffer.from("mockProofData"),
      root: ZERO_BYTES[DEFAULT_HEIGHT],  // Use the initial zero root
      inputNullifiers: [
        Array(32).fill(1),
        Array(32).fill(2)
      ],
      outputCommitments: [
        Array(32).fill(3),
        Array(32).fill(4)
      ],
      publicAmount: bnToBytes(new anchor.BN(0)),  // Zero public amount - intentional test case
      extDataHash: Array.from(calculatedExtDataHash)
    };

    // Execute the transaction
    const tx = await program.methods
      .transact(proof, extData)
      .accounts({
        treeAccount: treeAccountPDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: feeRecipientPDA,
        treeTokenAccount: treeTokenAccountPDA,
        authority: authority.publicKey,
        signer: randomUser.publicKey, // Use random user as signer
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser]) // Random user signs the transaction
      .rpc();
    
    expect(tx).to.be.a('string');
  });

  it("Transact succeeds with the correct root using zero external amount", async () => {
    // Fetch the Merkle tree account to get the current root
    const treeAccountData = await program.account.merkleTreeAccount.fetch(treeAccountPDA);

    // This should pass because we're using a fresh tree account with the initial root
    expect(treeAccountData.root).to.deep.equal(ZERO_BYTES[DEFAULT_HEIGHT]);
    
    // Test with zero external amount which is explicitly testing this case
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(0),  // Zero amount - intentional for this test
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(0),  // Zero fee - intentional for this test
      tokenMint: new PublicKey("11111111111111111111111111111111")
    };

    const calculatedExtDataHash = getExtDataHash(extData);
    
    // Create a Proof with the current valid root (initial root)
    const validProof = {
      proof: Buffer.from("mockProofData"),
      root: Array.from(treeAccountData.root), // Use the current valid root
      inputNullifiers: [
        Array(32).fill(1),
        Array(32).fill(2)
      ],
      outputCommitments: [
        Array(32).fill(3),
        Array(32).fill(4)
      ],
      publicAmount: bnToBytes(new anchor.BN(0)),  // Zero public amount - intentional test case
      extDataHash: Array.from(calculatedExtDataHash)
    };

    const transactTx = await program.methods
      .transact(validProof, extData)
      .accounts({
        treeAccount: treeAccountPDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: feeRecipientPDA,
        treeTokenAccount: treeTokenAccountPDA,
        authority: authority.publicKey,
        signer: randomUser.publicKey, // Use random user as signer
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser]) // Random user signs the transaction
      .rpc();
    
    expect(transactTx).to.be.a('string');
  });

  it("Multiple transactions succeed with zero external amount", async () => {
    // First transaction with zero amount - explicit test case
    const firstExtData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(0),  // Zero amount - intentional for this test
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(0),  // Zero fee - intentional for this test
      tokenMint: new PublicKey("11111111111111111111111111111111")
    };

    const firstExtDataHash = getExtDataHash(firstExtData);
    
    const firstProof = {
      proof: Buffer.from("mockProofData"),
      root: ZERO_BYTES[DEFAULT_HEIGHT], // Initial root
      inputNullifiers: [
        Array(32).fill(1),
        Array(32).fill(2)
      ],
      outputCommitments: [
        Array(32).fill(3),
        Array(32).fill(4)
      ],
      publicAmount: bnToBytes(new anchor.BN(0)),  // Zero public amount - intentional test case
      extDataHash: Array.from(firstExtDataHash)
    };

    // First transaction should succeed with the initial root
    await program.methods
      .transact(firstProof, firstExtData)
      .accounts({
        treeAccount: treeAccountPDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: feeRecipientPDA,
        treeTokenAccount: treeTokenAccountPDA,
        authority: authority.publicKey,
        signer: randomUser.publicKey, // Use random user as signer
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser]) // Random user signs the transaction
      .rpc();
    
    // Fetch the updated root
    const treeAccountData = await program.account.merkleTreeAccount.fetch(treeAccountPDA);
    
    // Second transaction with zero amount and updated root - explicit test case
    const secondExtData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(0),  // Zero amount - intentional for this test
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(0),  // Zero fee - intentional for this test
      tokenMint: new PublicKey("11111111111111111111111111111111")
    };

    const calculatedSecondExtDataHash = getExtDataHash(secondExtData);

    const secondValidProof = {
      proof: Buffer.from("mockProofData"),
      root: Array.from(treeAccountData.root), // Use the updated root
      inputNullifiers: [
        Array(32).fill(5), // Different nullifiers
        Array(32).fill(6)
      ],
      outputCommitments: [
        Array(32).fill(7), // Different commitments
        Array(32).fill(8)
      ],
      publicAmount: bnToBytes(new anchor.BN(0)),  // Zero public amount - intentional test case
      extDataHash: Array.from(calculatedSecondExtDataHash)
    };
    
    const secondTransactTx = await program.methods
      .transact(secondValidProof, secondExtData)
      .accounts({
        treeAccount: treeAccountPDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: feeRecipientPDA,
        treeTokenAccount: treeTokenAccountPDA,
        authority: authority.publicKey,
        signer: randomUser.publicKey, // Use random user as signer
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser]) // Random user signs the transaction
      .rpc();
    
    expect(secondTransactTx).to.be.a('string');
  });
});
