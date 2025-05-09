import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Zkcash } from "../target/types/zkcash"; // This should be `zkcash` unless the program name is actually "anchor"
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { DEFAULT_HEIGHT, ROOT_HISTORY_SIZE, ZERO_BYTES } from "./lib/constants";
import { getExtDataHash } from "../../scripts/utils/utils";

import * as crypto from "crypto";
import * as path from 'path';
import { Utxo } from "./lib/utxo";
import { parseProofToBytesArray, parseToBytesArray, prove, verify } from "./lib/prover";
import { utils } from 'ffjavascript';
import { LightWasm, WasmFactory } from "@lightprotocol/hasher.rs";

// Utility function to generate random 32-byte arrays for nullifiers
function generateRandomNullifier(): Uint8Array {
  return crypto.randomBytes(32);
}

export function bnToBytes(bn: anchor.BN): number[] {
  // Cast the result to number[] since we know the output is a byte array
  return Array.from(
    utils.leInt2Buff(utils.unstringifyBigInts(bn.toString()), 32)
  ).reverse() as number[];
}

import { poseidon1, poseidon2 } from 'poseidon-lite'
import { MerkleTree } from "./lib/merkle_tree";

// Find nullifier PDAs for the given proof
function findNullifierPDAs(program: anchor.Program<any>, proof: any) {
  const [nullifier0PDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier0"), Buffer.from(proof.inputNullifiers[0])],
    program.programId
  );
  
  const [nullifier1PDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier1"), Buffer.from(proof.inputNullifiers[1])],
    program.programId
  );
  
  return { nullifier0PDA, nullifier1PDA };
}

describe("zkcash", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  
  const program = anchor.workspace.Zkcash as Program<Zkcash>;
  let lightWasm: LightWasm;

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
    lightWasm = await WasmFactory.getInstance();
    
    // Airdrop SOL to the funding account
    console.log(`Airdropping SOL to funding account ${fundingAccount.publicKey.toBase58()}...`);
    const airdropSignature = await provider.connection.requestAirdrop(
      fundingAccount.publicKey,
      100 * LAMPORTS_PER_SOL // Airdrop 50 SOL
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
          tree_account: treeAccountPDA,
          fee_recipient_account: feeRecipientPDA,
          tree_token_account: treeTokenAccountPDA,
          authority: authority.publicKey,
          system_program: anchor.web3.SystemProgram.programId
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

  it("Can execute transact instruction for correct input, for both deposit and withdrawal", async () => {
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

    // Create the merkle tree with the pre-initialized poseidon hash
    const tree: MerkleTree = new MerkleTree(20, lightWasm);
    const treeAccountData = await program.account.merkleTreeAccount.fetch(treeAccountPDA);

    // Create inputs for the first deposit
    const inputs = [
      new Utxo({ }),
      new Utxo({ })
    ];

    const outputAmount = '150';
    const outputs = [
      new Utxo({ amount: outputAmount }), // Combined amount minus fee
      new Utxo({ amount: '0' }) // Empty UTXO
    ];

    // Create mock Merkle path data (normally built from the tree)
    const inputMerklePathIndices = inputs.map((input) => input.index || 0);
    
    // inputMerklePathElements won't be checked for empty utxos. so we need to create a sample full path
    // Create the Merkle paths for each input
    const inputMerklePathElements = inputs.map(() => {
      // Return an array of zero elements as the path for each input
      // Create a copy of the zeroElements array to avoid modifying the original
      return [...new Array(tree.levels).fill(0)];
    });

    // Resolve all async operations before creating the input object
    // Await nullifiers and commitments to get actual values instead of Promise objects
    const inputNullifiers = await Promise.all(inputs.map(x => x.getNullifier()));
    const outputCommitments = await Promise.all(outputs.map(x => x.getCommitment()));

    // Use the properly calculated Merkle tree root
    const root = tree.root();

    const input = {
      // Common transaction data
      root: root,
      inputNullifier: inputNullifiers, // Use resolved values instead of Promise objects
      outputCommitment: outputCommitments, // Use resolved values instead of Promise objects
      publicAmount: new anchor.BN(150),
      extDataHash: calculatedExtDataHash,
      
      // Input UTXO data (UTXOs being spent) - ensure all values are in decimal format
      inAmount: inputs.map(x => x.amount.toString(10)),
      inPrivateKey: inputs.map(x => x.keypair.privkey),
      inBlinding: inputs.map(x => x.blinding.toString(10)),
      inPathIndices: inputMerklePathIndices,
      inPathElements: inputMerklePathElements,
      
      // Output UTXO data (UTXOs being created) - ensure all values are in decimal format
      outAmount: outputs.map(x => x.amount.toString(10)),
      outBlinding: outputs.map(x => x.blinding.toString(10)),
      outPubkey: outputs.map(x => x.keypair.pubkey),
    };

    // Path to the proving key files (wasm and zkey)
    // Try with both circuits to see which one works
    const keyBasePath = path.resolve(__dirname, '../../artifacts/circuits/transaction2');
    const {proof, publicSignals} = await prove(input, keyBasePath);

    publicSignals.forEach((signal, index) => {
      const signalStr = signal.toString();
      let matchedKey = 'unknown';
      
      // Try to identify which input this signal matches
      for (const [key, value] of Object.entries(input)) {
        if (Array.isArray(value)) {
          if (value.some(v => v.toString() === signalStr)) {
            matchedKey = key;
            break;
          }
        } else if (value.toString() === signalStr) {
          matchedKey = key;
          break;
        }
      }
    });
    

    const proofInBytes = parseProofToBytesArray(proof);
    const inputsInBytes = parseToBytesArray(publicSignals);
    
    // Create a Proof object with the correctly calculated hash
    const proofToSubmit = {
      proofA: proofInBytes.proofA, // 64-byte array for proofA
      proofB: proofInBytes.proofB.flat(), // 128-byte array for proofB  
      proofC: proofInBytes.proofC, // 64-byte array for proofC
      root: inputsInBytes[0],
      publicAmount: inputsInBytes[1],
      extDataHash: inputsInBytes[2],
      inputNullifiers: [
        inputsInBytes[3],
        inputsInBytes[4]
      ],
      outputCommitments: [
        inputsInBytes[5],
        inputsInBytes[6]
      ],
    };

    // Derive nullifier PDAs
    const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program, proofToSubmit);

    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    // Execute the transaction without pre-instructions
    const tx = await program.methods
      .transact(proofToSubmit, extData)
      .accounts({
        tree_account: treeAccountPDA,
        nullifier0: nullifier0PDA,
        nullifier1: nullifier1PDA,
        recipient: recipient.publicKey,
        fee_recipient_account: feeRecipientPDA,
        tree_token_account: treeTokenAccountPDA,
        authority: authority.publicKey,
        signer: randomUser.publicKey, // Use random user as signer
        system_program: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser]) // Random user signs the transaction
      .preInstructions([modifyComputeUnits])
      .rpc();
    
    expect(tx).to.be.a('string');
    console.log('!!!!!! deposit success', tx);

    // After deposit succeeds, fetch the updated tree data
    const updatedTreeAccount = await program.account.merkleTreeAccount.fetch(treeAccountPDA);

    // After deposit, we need to update the tree with the new commitments
    for (const commitment of outputCommitments) {
      tree.insert(commitment);
    }

    // Create completely fresh UTXOs for the withdrawal inputs, copying necessary values
    const freshWithdrawalInput = new Utxo({
      amount: outputAmount,
      keypair: outputs[0].keypair, // Use the same keypair
      blinding: outputs[0].blinding, // Use the same blinding factor
      index: 0  // First position in tree
    });

    // Create a withdrawal ExtData
    const withdrawalExtData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(-100),
      encryptedOutput1: Buffer.from("withdrawalEncryptedOutput1"),
      encryptedOutput2: Buffer.from("withdrawalEncryptedOutput2"),
      fee: new anchor.BN(50),
      tokenMint: new PublicKey("11111111111111111111111111111111")
    };

    // Fresh outputs for withdrawal
    const withdrawalOutputs = [
      new Utxo({ amount: '0' }),
      new Utxo({ amount: '0' })
    ];

    // Get the Merkle path for the input
    const withdrawalMerklePathElements = [tree.path(0), [...new Array(tree.levels).fill(0)]];
    const withdrawalMerklePathIndices = [0, 0];

    // Get nullifiers and commitments
    const withdrawalInputNullifiers = await Promise.all([
      freshWithdrawalInput.getNullifier(),
      new Utxo({}).getNullifier()
    ]);

    const withdrawalOutputCommitments = await Promise.all(withdrawalOutputs.map(x => x.getCommitment()));

    // Create withdrawal input object
    const withdrawalInput = {
      root: updatedTreeAccount.root,
      inputNullifier: withdrawalInputNullifiers,
      outputCommitment: withdrawalOutputCommitments,
      publicAmount: new anchor.BN(150), // |extAmount| + fee = 100 + 50
      extDataHash: getExtDataHash(withdrawalExtData),
      
      inAmount: [freshWithdrawalInput.amount.toString(10), '0'],
      inPrivateKey: [freshWithdrawalInput.keypair.privkey, new Utxo({}).keypair.privkey],
      inBlinding: [freshWithdrawalInput.blinding.toString(10), new Utxo({}).blinding.toString(10)],
      inPathIndices: withdrawalMerklePathIndices,
      inPathElements: withdrawalMerklePathElements,
      
      outAmount: withdrawalOutputs.map(x => x.amount.toString(10)),
      outBlinding: withdrawalOutputs.map(x => x.blinding.toString(10)),
      outPubkey: withdrawalOutputs.map(x => x.keypair.pubkey),
    };

    // Generate proof for withdrawal
    const withdrawalProofResult = await prove(withdrawalInput, keyBasePath);
    const withdrawalProofInBytes = parseProofToBytesArray(withdrawalProofResult.proof);
    const withdrawalInputsInBytes = parseToBytesArray(withdrawalProofResult.publicSignals);

    // Create withdrawal proof object
    const withdrawalProofToSubmit = {
      proofA: withdrawalProofInBytes.proofA,
      proofB: withdrawalProofInBytes.proofB.flat(),
      proofC: withdrawalProofInBytes.proofC,
      root: withdrawalInputsInBytes[0],
      publicAmount: withdrawalInputsInBytes[1],
      extDataHash: withdrawalInputsInBytes[2],
      inputNullifiers: [
        withdrawalInputsInBytes[3],
        withdrawalInputsInBytes[4]
      ],
      outputCommitments: [
        withdrawalInputsInBytes[5],
        withdrawalInputsInBytes[6]
      ],
    };

    // Find PDAs for withdrawal
    const withdrawalNullifierPDAs = findNullifierPDAs(program, withdrawalProofToSubmit);

    // Execute withdrawal transaction
    const withdrawalTx = await program.methods
      .transact(withdrawalProofToSubmit, withdrawalExtData)
      .accounts({
        tree_account: treeAccountPDA,
        nullifier0: withdrawalNullifierPDAs.nullifier0PDA,
        nullifier1: withdrawalNullifierPDAs.nullifier1PDA,
        recipient: recipient.publicKey,
        fee_recipient_account: feeRecipientPDA,
        tree_token_account: treeTokenAccountPDA,
        authority: authority.publicKey,
        signer: randomUser.publicKey,
        system_program: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .preInstructions([modifyComputeUnits])
      .rpc();

    expect(withdrawalTx).to.be.a('string');
  });
});

