import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Zkcash } from "../target/types/zkcash"; // This should be `zkcash` unless the program name is actually "anchor"
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { DEFAULT_HEIGHT, ROOT_HISTORY_SIZE, ZERO_BYTES } from "./constants";
import { getExtDataHash } from "../../scripts/utils/utils";

describe("zkcash", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  
  const program = anchor.workspace.Zkcash as Program<Zkcash>;

  // Generate keypairs for the accounts needed in the test
  const treeAccount = anchor.web3.Keypair.generate();
  const authority = anchor.web3.Keypair.generate();
  const recipient = anchor.web3.Keypair.generate();

  // --- Funding the Authority Wallet ---
  before(async () => {
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

  it("Is initialized successfully", async () => {
    console.log(`Initializing with tree account: ${treeAccount.publicKey.toBase58()}`);
    console.log(`Using authority: ${authority.publicKey.toBase58()}`);
    
    const tx = await program.methods
      .initialize()
      .accounts({
        treeAccount: treeAccount.publicKey,
        authority: authority.publicKey,
      })
      .signers([treeAccount, authority])
      .rpc();
    
    console.log("Initialization transaction signature", tx);

    const merkleTreeAccount = await program.account.merkleTreeAccount.fetch(treeAccount.publicKey);
    // console.log("Tree account data:", merkleTreeAccount);

    expect(merkleTreeAccount.authority.equals(authority.publicKey)).to.be.true;
    expect(merkleTreeAccount.nextIndex.toString()).to.equal("0");
    expect(merkleTreeAccount.rootIndex.toString()).to.equal("0");
    expect(merkleTreeAccount.rootHistory.length).to.equal(ROOT_HISTORY_SIZE);
    expect(merkleTreeAccount.root).to.deep.equal(ZERO_BYTES[DEFAULT_HEIGHT]);
    expect(merkleTreeAccount.rootHistory[0]).to.deep.equal(ZERO_BYTES[DEFAULT_HEIGHT]);

    for (let i = 0; i < DEFAULT_HEIGHT; i++) {
      expect(merkleTreeAccount.subtrees[i]).to.deep.equal(ZERO_BYTES[i]);
    }
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
      publicAmount: new anchor.BN(100),
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
      publicAmount: new anchor.BN(100),
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
});

