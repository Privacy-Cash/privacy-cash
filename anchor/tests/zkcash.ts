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
  let treeAccount: anchor.web3.Keypair;
  let authority: anchor.web3.Keypair;
  let recipient: anchor.web3.Keypair;

  // --- Funding the Authority Wallet ---
  before(async () => {
    // Generate the authority keypair once
    authority = anchor.web3.Keypair.generate();
    
    // Airdrop SOL to the authority wallet.
    console.log(`Airdropping SOL to ${authority.publicKey.toBase58()}...`);
    const airdropSignature = await provider.connection.requestAirdrop(
      authority.publicKey,
      2 * LAMPORTS_PER_SOL // Airdrop 2 SOL
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
    const balance = await provider.connection.getBalance(authority.publicKey);
    console.log(`Authority balance: ${balance / LAMPORTS_PER_SOL} SOL`);
    expect(balance).to.be.greaterThan(0);
  });

  // Reset program state before each test
  beforeEach(async () => {
    // Generate new keypairs for each test to ensure a clean state
    treeAccount = anchor.web3.Keypair.generate();
    recipient = anchor.web3.Keypair.generate();
    
    console.log(`Initializing fresh tree account: ${treeAccount.publicKey.toBase58()}`);
    
    // Initialize a fresh tree account for each test
    await program.methods
      .initialize()
      .accounts({
        treeAccount: treeAccount.publicKey,
        authority: authority.publicKey,
      })
      .signers([treeAccount, authority])
      .rpc();
      
    // Verify the initialization was successful
    const merkleTreeAccount = await program.account.merkleTreeAccount.fetch(treeAccount.publicKey);
    expect(merkleTreeAccount.authority.equals(authority.publicKey)).to.be.true;
    expect(merkleTreeAccount.nextIndex.toString()).to.equal("0");
    expect(merkleTreeAccount.rootIndex.toString()).to.equal("0");
    expect(merkleTreeAccount.rootHistory.length).to.equal(ROOT_HISTORY_SIZE);
    expect(merkleTreeAccount.root).to.deep.equal(ZERO_BYTES[DEFAULT_HEIGHT]);
  });

  it("Can execute transact instruction for correct input", async () => {
    console.log(`Testing transact instruction with recipient: ${recipient.publicKey.toBase58()}`);
    
    // Create a sample ExtData object
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(-100),
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(100),
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
      publicAmount: bnToBytes(new anchor.BN(100)),
      extDataHash: Array.from(calculatedExtDataHash)
    };

    // Execute the transaction
    const tx = await program.methods
      .transact(proof, extData)
      .accounts({
        treeAccount: treeAccount.publicKey,
        recipient: recipient.publicKey,
        signer: authority.publicKey,
      })
      .signers([authority])
      .rpc();
    
    console.log("Transact transaction signature:", tx);
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
      publicAmount: bnToBytes(new anchor.BN(100)),
      extDataHash: Array.from(incorrectExtDataHash)
    };

    try {
      // Execute the transaction - this should fail because the hash doesn't match
      await program.methods
        .transact(proof, extData)
        .accounts({
          treeAccount: treeAccount.publicKey,
          recipient: recipient.publicKey,
          signer: authority.publicKey,
        })
        .signers([authority])
        .rpc();
      
      // If we reach here, the test should fail because the transaction should have thrown an error
      expect.fail("Transaction should have failed but succeeded");
    } catch (error) {
      // Check if the error is an AnchorError with the expected error code
      if (error instanceof anchor.AnchorError) {
        console.log(`Got expected AnchorError: ${error.error.errorMessage}`);
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
      publicAmount: bnToBytes(new anchor.BN(100)),
      extDataHash: Array.from(calculatedExtDataHash)
    };

    try {
      // Execute the transaction - this should fail because the root is unknown
      await program.methods
        .transact(proof, extData)
        .accounts({
          treeAccount: treeAccount.publicKey,
          recipient: recipient.publicKey,
          signer: authority.publicKey,
        })
        .signers([authority])
        .rpc();
      
      // If we reach here, the test should fail because the transaction should have thrown an error
      expect.fail("Transaction should have failed due to unknown root but succeeded");
    } catch (error) {
      // Check if the error is an AnchorError with the expected error code
      if (error instanceof anchor.AnchorError) {
        console.log(`Got expected AnchorError: ${error.error.errorMessage}`);
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
      publicAmount: bnToBytes(new anchor.BN(100)),
      extDataHash: Array.from(calculatedExtDataHash)
    };

    try {
      // Execute the transaction - this should fail because the root is unknown
      await program.methods
        .transact(proof, extData)
        .accounts({
          treeAccount: treeAccount.publicKey,
          recipient: recipient.publicKey,
          signer: authority.publicKey,
        })
        .signers([authority])
        .rpc();
      
      // If we reach here, the test should fail because the transaction should have thrown an error
      expect.fail("Transaction should have failed due to unknown root but succeeded");
    } catch (error) {
      // Check if the error is an AnchorError with the expected error code
      if (error instanceof anchor.AnchorError) {
        console.log(`Got expected AnchorError: ${error.error.errorMessage}`);
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
    const treeAccountData = await program.account.merkleTreeAccount.fetch(treeAccount.publicKey);

    // This should now pass because we're using a fresh tree account for each test
    expect(treeAccountData.root).to.deep.equal(ZERO_BYTES[DEFAULT_HEIGHT]);
    
    // Test that a transaction with the initial root works
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(-100),
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(100),
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
      publicAmount: bnToBytes(new anchor.BN(100)),
      extDataHash: Array.from(calculatedExtDataHash)
    };

    // This transaction should succeed because the root is valid
    const transactTx = await program.methods
      .transact(validProof, extData)
      .accounts({
        treeAccount: treeAccount.publicKey,
        recipient: recipient.publicKey,
        signer: authority.publicKey,
      })
      .signers([authority])
      .rpc();
    
    console.log("Transact with valid root transaction signature:", transactTx);
    expect(transactTx).to.be.a('string');
  });

  it("Transact succeeds after the second root update", async () => {
    // First transaction to update the root
    const firstExtData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(-100),
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(100),
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
      publicAmount: bnToBytes(new anchor.BN(100)),
      extDataHash: Array.from(firstExtDataHash)
    };

    // This transaction should succeed with the initial root
    await program.methods
      .transact(firstProof, firstExtData)
      .accounts({
        treeAccount: treeAccount.publicKey,
        recipient: recipient.publicKey,
        signer: authority.publicKey,
      })
      .signers([authority])
      .rpc();
    
    // Fetch the updated root
    const treeAccountData = await program.account.merkleTreeAccount.fetch(treeAccount.publicKey);
    
    // Second transaction with the updated root
    const secondExtData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(-200),
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(100),
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
      publicAmount: bnToBytes(new anchor.BN(100)),
      extDataHash: Array.from(calculatedSecondExtDataHash)
    };
    
    // This transaction should succeed because the root is valid
    const secondTransactTx = await program.methods
      .transact(secondValidProof, secondExtData)
      .accounts({
        treeAccount: treeAccount.publicKey,
        recipient: recipient.publicKey,
        signer: authority.publicKey,
      })
      .signers([authority])
      .rpc();
    
    console.log("Second transaction signature:", secondTransactTx);
    expect(secondTransactTx).to.be.a('string');
  });
});
