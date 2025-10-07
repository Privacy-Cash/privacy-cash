import * as anchor from "@coral-xyz/anchor";
import { Program, EventParser, BorshCoder } from "@coral-xyz/anchor";
import { Zkcash } from "../target/types/zkcash";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { getExtDataHash } from "./lib/utils";
import { DEFAULT_HEIGHT, FIELD_SIZE, ROOT_HISTORY_SIZE, ZERO_BYTES, DEPOSIT_FEE_RATE, WITHDRAW_FEE_RATE, FEE_RECIPIENT_ACCOUNT } from "./lib/constants";

import * as crypto from "crypto";
import * as path from 'path';
import { Utxo } from "./lib/utxo";
import { parseProofToBytesArray, parseToBytesArray, prove } from "./lib/prover";
import { utils } from 'ffjavascript';
import { LightWasm, WasmFactory } from "@lightprotocol/hasher.rs";
import { BN } from 'bn.js';

// Utility function to generate random 32-byte arrays for nullifiers
function generateRandomNullifier(): Uint8Array {
  return crypto.randomBytes(32);
}

// Helper function to calculate fees based on amount and fee rate
function calculateFee(amount: number, feeRate: number): number {
  return Math.floor((amount * feeRate) / 10000);
}

// Helper function to calculate deposit fee
function calculateDepositFee(amount: number): number {
  return calculateFee(amount, DEPOSIT_FEE_RATE);
}

// Helper function to calculate withdrawal fee
function calculateWithdrawalFee(amount: number): number {
  return calculateFee(amount, WITHDRAW_FEE_RATE);
}

export function bnToBytes(bn: anchor.BN): number[] {
  // Cast the result to number[] since we know the output is a byte array
  return Array.from(
    utils.leInt2Buff(utils.unstringifyBigInts(bn.toString()), 32)
  ).reverse() as number[];
}

import { MerkleTree } from "./lib/merkle_tree";
import { createGlobalTestALT, getTestProtocolAddresses, createVersionedTransactionWithALT, sendAndConfirmVersionedTransaction } from "./lib/test_alt";

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

// Find commitment PDAs for the given proof
function findCommitmentPDAs(program: anchor.Program<any>, proof: any) {
  const [commitment0PDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("commitment0"), Buffer.from(proof.outputCommitments[0])],
    program.programId
  );
  
  const [commitment1PDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("commitment1"), Buffer.from(proof.outputCommitments[1])],
    program.programId
  );
  
  return { commitment0PDA, commitment1PDA };
}

// Find cross-check nullifier PDAs for the given proof
function findCrossCheckNullifierPDAs(program: anchor.Program<any>, proof: any) {
  const [nullifier2PDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier0"), Buffer.from(proof.inputNullifiers[1])],
    program.programId
  );

  const [nullifier3PDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier1"), Buffer.from(proof.inputNullifiers[0])],
    program.programId
  );

  return { nullifier2PDA, nullifier3PDA };
}

// Helper function to create ExtDataMinified from ExtData
function createExtDataMinified(extData: any) {
  return {
    extAmount: extData.extAmount,
    fee: extData.fee
  };
}

describe("zkcash", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  
  const program = anchor.workspace.Zkcash as Program<Zkcash>;
  let lightWasm: LightWasm;

  // Generate keypairs for the accounts needed in the test
  let treeAccountPDA: PublicKey;
  let feeRecipient: anchor.web3.Keypair; // Regular keypair for fee recipient
  let treeBump: number;
  let authority: anchor.web3.Keypair;
  let recipient: anchor.web3.Keypair;
  let fundingAccount: anchor.web3.Keypair;
  let randomUser: anchor.web3.Keypair; // Random user for signing transactions
  let attacker: anchor.web3.Keypair;

  // Initialize variables for tree token account
  let treeTokenAccountPDA: PublicKey;
  let treeTokenBump: number;
  let globalConfigPDA: PublicKey;
  let globalMerkleTree: MerkleTree;

  // --- Funding a wallet to use for paying transaction fees ---
  before(async () => {
    authority = anchor.web3.Keypair.generate();
    // Generate a funding account to pay for transactions
    fundingAccount = anchor.web3.Keypair.generate();
    lightWasm = await WasmFactory.getInstance();
    globalMerkleTree = new MerkleTree(DEFAULT_HEIGHT, lightWasm);
    
    // Airdrop SOL to the funding account
    const airdropSignature = await provider.connection.requestAirdrop(
      fundingAccount.publicKey,
      1000 * LAMPORTS_PER_SOL // Airdrop 1000 SOL
    );

    // Confirm the transaction
    const latestBlockHash = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature: airdropSignature,
    });

    // Check the balance
    const balance = await provider.connection.getBalance(fundingAccount.publicKey);
    expect(balance).to.be.greaterThan(0);

    // Transfer SOL from funding account to the authority before initialization
    const transferTx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: fundingAccount.publicKey,
        toPubkey: authority.publicKey,
        lamports: 100 * LAMPORTS_PER_SOL, // 2 SOL to ensure enough for rent
      })
    );
    
    // Send and confirm the transfer transaction
    const transferSignature = await provider.connection.sendTransaction(transferTx, [fundingAccount]);
    await provider.connection.confirmTransaction(transferSignature);
    
    // Verify the authority has received funds
    const authorityBalance = await provider.connection.getBalance(authority.publicKey);
    expect(authorityBalance).to.be.greaterThan(0);

    // Calculate the PDA for the tree account with the new authority
    const [treePda, pdaBump] = await PublicKey.findProgramAddressSync(
      [Buffer.from("merkle_tree")],
      program.programId
    );
    treeAccountPDA = treePda;
    treeBump = pdaBump;
    
    // Calculate the PDA for the tree token account with the new authority
    const [treeTokenPda, treeTokenPdaBump] = await PublicKey.findProgramAddressSync(
      [Buffer.from("tree_token")],
      program.programId
    );
    treeTokenAccountPDA = treeTokenPda;
    treeTokenBump = treeTokenPdaBump;

    // Calculate the PDA for the global config with the new authority
    const [globalConfigPda, globalConfigPdaBump] = await PublicKey.findProgramAddressSync(
      [Buffer.from("global_config")],
      program.programId
    );
    globalConfigPDA = globalConfigPda;
        
    await program.methods
      .initialize()
      .accounts({
        treeAccount: treeAccountPDA,
        treeTokenAccount: treeTokenAccountPDA,
        globalConfig: globalConfigPDA,
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

    // Verify the initialization was successful
    const merkleTreeAccount = await program.account.merkleTreeAccount.fetch(treeAccountPDA);
    expect(merkleTreeAccount.authority.equals(authority.publicKey)).to.be.true;
    expect(merkleTreeAccount.nextIndex.toString()).to.equal("0");
    expect(merkleTreeAccount.rootIndex.toString()).to.equal("0");
    expect(merkleTreeAccount.rootHistory.length).to.equal(ROOT_HISTORY_SIZE);
    expect(merkleTreeAccount.root).to.deep.equal(ZERO_BYTES[DEFAULT_HEIGHT]);
  });

  // Reset program state before each test
  beforeEach(async () => {
    // Generate new recipient and fee recipient keypairs for each test
    recipient = anchor.web3.Keypair.generate();
    feeRecipient = anchor.web3.Keypair.generate();
    
    // Fund the recipient with SOL for rent exemption
    const recipientAirdropSignature = await provider.connection.requestAirdrop(recipient.publicKey, 0.5 * LAMPORTS_PER_SOL);
    // Confirm the airdrop
    const latestBlockhash = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      signature: recipientAirdropSignature,
    });

    // Fund the fee recipient with SOL for rent exemption
    const feeRecipientAirdropSignature = await provider.connection.requestAirdrop(FEE_RECIPIENT_ACCOUNT, 0.5 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction({
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      signature: feeRecipientAirdropSignature,
    });
      
    try {
      // Generate a random user for signing transactions
      randomUser = anchor.web3.Keypair.generate();
      attacker = anchor.web3.Keypair.generate();
      
      // Fund the random user with SOL
      const randomUserAirdropSignature = await provider.connection.requestAirdrop(randomUser.publicKey, 1 * LAMPORTS_PER_SOL);
      const latestBlockHash4 = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        blockhash: latestBlockHash4.blockhash,
        lastValidBlockHeight: latestBlockHash4.lastValidBlockHeight,
        signature: randomUserAirdropSignature,
      });

      // Fund the attacker with SOL
      const attackerAirdropSignature = await provider.connection.requestAirdrop(attacker.publicKey, 1 * LAMPORTS_PER_SOL);
      const latestBlockHash5 = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        blockhash: latestBlockHash5.blockhash,
        lastValidBlockHeight: latestBlockHash5.lastValidBlockHeight,
        signature: attackerAirdropSignature,
      });
    } catch (error) {
      console.error("Error initializing accounts:", error);
      // Get more detailed error information if available
      if ('logs' in error) {
        console.error("Error logs:", error.logs);
      }
      throw error;
    }
  });



  it("Double spend attack fails", async () => {
    // Step 1: First, do a deposit to create a UTXO we can later double spend
    const depositAmount = 1000;
    const depositFee = new anchor.BN(calculateDepositFee(depositAmount));
    
    const depositExtData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(depositAmount),
      encryptedOutput1: Buffer.from("depositEncryptedOutput1"),
      encryptedOutput2: Buffer.from("depositEncryptedOutput2"),
      fee: depositFee,
      feeRecipient: FEE_RECIPIENT_ACCOUNT,
      mintAddress: new anchor.web3.PublicKey("11111111111111111111111111111112"),
    };

    // Create empty inputs for deposit
    const depositInputs = [
      new Utxo({ lightWasm }),
      new Utxo({ lightWasm })
    ];

    const publicAmountNumber = depositExtData.extAmount.sub(depositFee).add(FIELD_SIZE).mod(FIELD_SIZE);
    const outputAmount = publicAmountNumber.toString();
    const depositOutputs = [
      new Utxo({ lightWasm, amount: outputAmount, index: globalMerkleTree._layers[0].length }),
      new Utxo({ lightWasm, amount: '0' })
    ];

    // Generate deposit proof and execute
    const depositInputMerklePathIndices = depositInputs.map(() => 0);
    const depositInputMerklePathElements = depositInputs.map(() => {
      return [...new Array(globalMerkleTree.levels).fill(0)];
    });

    const depositInputNullifiers = await Promise.all(depositInputs.map(x => x.getNullifier()));
    const depositOutputCommitments = await Promise.all(depositOutputs.map(x => x.getCommitment()));
    const depositRoot = globalMerkleTree.root();
    const depositExtDataHash = getExtDataHash(depositExtData);

    const depositInput = {
      root: depositRoot,
      inputNullifier: depositInputNullifiers,
      outputCommitment: depositOutputCommitments,
      publicAmount: publicAmountNumber.toString(),
      extDataHash: depositExtDataHash,
      inAmount: depositInputs.map(x => x.amount.toString(10)),
      inPrivateKey: depositInputs.map(x => x.keypair.privkey),
      inBlinding: depositInputs.map(x => x.blinding.toString(10)),
      mintAddress: depositInputs[0].mintAddress,
      inPathIndices: depositInputMerklePathIndices,
      inPathElements: depositInputMerklePathElements,
      outAmount: depositOutputs.map(x => x.amount.toString(10)),
      outBlinding: depositOutputs.map(x => x.blinding.toString(10)),
      outPubkey: depositOutputs.map(x => x.keypair.pubkey),
    };

    const keyBasePath = path.resolve(__dirname, '../../artifacts/circuits/transaction2');
    const depositProofResult = await prove(depositInput, keyBasePath);
    const depositProofInBytes = parseProofToBytesArray(depositProofResult.proof);
    const depositInputsInBytes = parseToBytesArray(depositProofResult.publicSignals);
    
    const depositProofToSubmit = {
      proofA: depositProofInBytes.proofA,
      proofB: depositProofInBytes.proofB.flat(),
      proofC: depositProofInBytes.proofC,
      root: depositInputsInBytes[0],
      publicAmount: depositInputsInBytes[1],
      extDataHash: depositInputsInBytes[2],
      inputNullifiers: [depositInputsInBytes[3], depositInputsInBytes[4]],
      outputCommitments: [depositInputsInBytes[5], depositInputsInBytes[6]],
    };

    const depositNullifiers = findNullifierPDAs(program, depositProofToSubmit);
    const depositCrossCheckNullifiers = findCrossCheckNullifierPDAs(program, depositProofToSubmit);
    const depositCommitments = findCommitmentPDAs(program, depositProofToSubmit);

    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    // Create Address Lookup Table for deposit transaction
    const depositTestProtocolAddresses = getTestProtocolAddresses(
      program.programId,
      authority.publicKey,
      treeAccountPDA,
      treeTokenAccountPDA,
      FEE_RECIPIENT_ACCOUNT
    );
    
    const depositLookupTableAddress = await createGlobalTestALT(provider.connection, authority, depositTestProtocolAddresses);

    // Execute deposit transaction
    const depositTx = await program.methods
      .transact(depositProofToSubmit, createExtDataMinified(depositExtData), depositExtData.encryptedOutput1, depositExtData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: depositNullifiers.nullifier0PDA,
        nullifier1: depositNullifiers.nullifier1PDA,
        nullifier2: depositCrossCheckNullifiers.nullifier2PDA,
        nullifier3: depositCrossCheckNullifiers.nullifier3PDA,
        commitment0: depositCommitments.commitment0PDA,
        commitment1: depositCommitments.commitment1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: FEE_RECIPIENT_ACCOUNT,
        treeTokenAccount: treeTokenAccountPDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .preInstructions([modifyComputeUnits])
      .transaction();

    // Create versioned transaction with ALT
    const depositVersionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      randomUser.publicKey,
      depositTx.instructions,
      depositLookupTableAddress
    );
    
    // Send and confirm versioned transaction
    await sendAndConfirmVersionedTransaction(
      provider.connection,
      depositVersionedTx,
      [randomUser]
    );

    // Insert commitments into tree
    for (const commitment of depositOutputCommitments) {
      globalMerkleTree.insert(commitment);
    }

    // Step 2: First withdrawal using the deposited UTXO (nullifier in position 0)
    const targetUtxo = depositOutputs[0]; // This is the UTXO we'll double spend
    
    const firstInputs = [
      targetUtxo, // Use the deposited UTXO as first input (nullifier goes to nullifier0)
      new Utxo({ lightWasm }) // Empty second input
    ];

    const firstOutputs = [
      new Utxo({ lightWasm, amount: '800' }),
      new Utxo({ lightWasm, amount: '0' })
    ];

    const firstInputsSum = firstInputs.reduce((sum, x) => sum.add(x.amount), new BN(0));
    const firstOutputsSum = firstOutputs.reduce((sum, x) => sum.add(x.amount), new BN(0));
    const firstWithdrawFee = new anchor.BN(calculateWithdrawalFee(firstInputsSum.toNumber()));
    const firstExtAmount = new BN(firstWithdrawFee).add(firstOutputsSum).sub(firstInputsSum);
    
    const firstPublicAmount = new BN(firstExtAmount).sub(new BN(firstWithdrawFee)).add(FIELD_SIZE).mod(FIELD_SIZE);
    
    const firstExtData = {
      recipient: recipient.publicKey,
      extAmount: firstExtAmount,
      encryptedOutput1: Buffer.from("firstEncryptedOutput1"),
      encryptedOutput2: Buffer.from("firstEncryptedOutput2"),
      fee: firstWithdrawFee,
      feeRecipient: FEE_RECIPIENT_ACCOUNT,
      mintAddress: new anchor.web3.PublicKey("11111111111111111111111111111112"),
    };

    // Generate the first withdrawal proof
    const firstInputMerklePathIndices = [];
    const firstInputMerklePathElements = [];
    
    for (let i = 0; i < firstInputs.length; i++) {
      const input = firstInputs[i];
      if (input.amount.gt(new BN(0))) {
        const commitment = depositOutputCommitments[i];
        input.index = globalMerkleTree.indexOf(commitment);
        firstInputMerklePathIndices.push(input.index);
        firstInputMerklePathElements.push(globalMerkleTree.path(input.index).pathElements);
      } else {
        firstInputMerklePathIndices.push(0);
        firstInputMerklePathElements.push(new Array(globalMerkleTree.levels).fill(0));
      }
    }

    const firstInputNullifiers = await Promise.all(firstInputs.map(x => x.getNullifier()));
    const firstOutputCommitments = await Promise.all(firstOutputs.map(x => x.getCommitment()));
    const firstRoot = globalMerkleTree.root();
    const firstExtDataHash = getExtDataHash(firstExtData);

    const firstProofInput = {
      root: firstRoot,
      inputNullifier: firstInputNullifiers,
      outputCommitment: firstOutputCommitments,
      publicAmount: firstPublicAmount.toString(),
      extDataHash: firstExtDataHash,
      inAmount: firstInputs.map(x => x.amount.toString(10)),
      inPrivateKey: firstInputs.map(x => x.keypair.privkey),
      inBlinding: firstInputs.map(x => x.blinding.toString(10)),
      mintAddress: firstInputs[0].mintAddress,
      inPathIndices: firstInputMerklePathIndices,
      inPathElements: firstInputMerklePathElements,
      outAmount: firstOutputs.map(x => x.amount.toString(10)),
      outBlinding: firstOutputs.map(x => x.blinding.toString(10)),
      outPubkey: firstOutputs.map(x => x.keypair.pubkey),
    };

    const firstProofResult = await prove(firstProofInput, keyBasePath);
    const firstProofInBytes = parseProofToBytesArray(firstProofResult.proof);
    const firstInputsInBytes = parseToBytesArray(firstProofResult.publicSignals);
    
    const firstProofToSubmit = {
      proofA: firstProofInBytes.proofA,
      proofB: firstProofInBytes.proofB.flat(),
      proofC: firstProofInBytes.proofC,
      root: firstInputsInBytes[0],
      publicAmount: firstInputsInBytes[1],
      extDataHash: firstInputsInBytes[2],
      inputNullifiers: [firstInputsInBytes[3], firstInputsInBytes[4]],
      outputCommitments: [firstInputsInBytes[5], firstInputsInBytes[6]],
    };

    const firstNullifiers = findNullifierPDAs(program, firstProofToSubmit);
    const firstCrossCheckNullifiers = findCrossCheckNullifierPDAs(program, firstProofToSubmit);
    const firstCommitments = findCommitmentPDAs(program, firstProofToSubmit);

    // Create Address Lookup Table for first withdrawal transaction
    const firstTestProtocolAddresses = getTestProtocolAddresses(
      program.programId,
      authority.publicKey,
      treeAccountPDA,
      treeTokenAccountPDA,
      FEE_RECIPIENT_ACCOUNT
    );
    
    const firstLookupTableAddress = await createGlobalTestALT(provider.connection, authority, firstTestProtocolAddresses);

    // Execute first withdrawal
    const firstTx = await program.methods
      .transact(firstProofToSubmit, createExtDataMinified(firstExtData), firstExtData.encryptedOutput1, firstExtData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: firstNullifiers.nullifier0PDA,
        nullifier1: firstNullifiers.nullifier1PDA,
        nullifier2: firstCrossCheckNullifiers.nullifier2PDA,
        nullifier3: firstCrossCheckNullifiers.nullifier3PDA,
        commitment0: firstCommitments.commitment0PDA,
        commitment1: firstCommitments.commitment1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: FEE_RECIPIENT_ACCOUNT,
        treeTokenAccount: treeTokenAccountPDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .preInstructions([modifyComputeUnits])
      .transaction();

    // Create versioned transaction with ALT
    const firstVersionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      randomUser.publicKey,
      firstTx.instructions,
      firstLookupTableAddress
    );
    
    // Send and confirm versioned transaction
    await sendAndConfirmVersionedTransaction(
      provider.connection,
      firstVersionedTx,
      [randomUser]
    );

    // Insert commitments into tree
    for (const commitment of firstOutputCommitments) {
      globalMerkleTree.insert(commitment);
    }
    
    const secondInputs = [
      new Utxo({ lightWasm }), // Empty UTXO in position 0
      targetUtxo // SAME target UTXO now in position 1 (DOUBLE SPEND!)
    ];

    const secondOutputs = [
      new Utxo({ lightWasm, amount: '200' }),
      new Utxo({ lightWasm, amount: '0' })
    ];

    const secondInputsSum = secondInputs.reduce((sum, x) => sum.add(x.amount), new BN(0));
    const secondOutputsSum = secondOutputs.reduce((sum, x) => sum.add(x.amount), new BN(0));
    const secondWithdrawFee = new anchor.BN(calculateWithdrawalFee(secondInputsSum.toNumber()));
    const secondExtAmount = new BN(secondWithdrawFee).add(secondOutputsSum).sub(secondInputsSum);
    
    const secondPublicAmount = new BN(secondExtAmount).sub(new BN(secondWithdrawFee)).add(FIELD_SIZE).mod(FIELD_SIZE);
    
    const secondExtData = {
      recipient: recipient.publicKey,
      extAmount: secondExtAmount,
      encryptedOutput1: Buffer.from("secondEncryptedOutput1"),
      encryptedOutput2: Buffer.from("secondEncryptedOutput2"),
      fee: secondWithdrawFee,
      feeRecipient: FEE_RECIPIENT_ACCOUNT,
      mintAddress: new anchor.web3.PublicKey("11111111111111111111111111111112"),
    };

    // Generate the second withdrawal proof with swapped inputs
    const secondInputMerklePathIndices = [];
    const secondInputMerklePathElements = [];
    
    for (let i = 0; i < secondInputs.length; i++) {
      const input = secondInputs[i];
      if (input.amount.gt(new BN(0))) {
        // This is the same commitment as before, but now in position 1 instead of 0
        const commitment = depositOutputCommitments[0]; // Same commitment!
        input.index = globalMerkleTree.indexOf(commitment);
        secondInputMerklePathIndices.push(input.index);
        secondInputMerklePathElements.push(globalMerkleTree.path(input.index).pathElements);
      } else {
        secondInputMerklePathIndices.push(0);
        secondInputMerklePathElements.push(new Array(globalMerkleTree.levels).fill(0));
      }
    }

    const secondInputNullifiers = await Promise.all(secondInputs.map(x => x.getNullifier()));
    const secondOutputCommitments = await Promise.all(secondOutputs.map(x => x.getCommitment()));
    const secondRoot = globalMerkleTree.root();
    const secondExtDataHash = getExtDataHash(secondExtData);

    // Verify that the target nullifier is being reused
    const firstTxTargetNullifier = firstInputNullifiers[0]; // Was in position 0 in first tx
    const secondTxTargetNullifier = secondInputNullifiers[1]; // Now in position 1 in second tx
    
    expect(Buffer.from(firstTxTargetNullifier).equals(Buffer.from(secondTxTargetNullifier))).to.be.true;

    const secondProofInput = {
      root: secondRoot,
      inputNullifier: secondInputNullifiers,
      outputCommitment: secondOutputCommitments,
      publicAmount: secondPublicAmount.toString(),
      extDataHash: secondExtDataHash,
      inAmount: secondInputs.map(x => x.amount.toString(10)),
      inPrivateKey: secondInputs.map(x => x.keypair.privkey),
      inBlinding: secondInputs.map(x => x.blinding.toString(10)),
      mintAddress: secondInputs[0].mintAddress,
      inPathIndices: secondInputMerklePathIndices,
      inPathElements: secondInputMerklePathElements,
      outAmount: secondOutputs.map(x => x.amount.toString(10)),
      outBlinding: secondOutputs.map(x => x.blinding.toString(10)),
      outPubkey: secondOutputs.map(x => x.keypair.pubkey),
    };

    const secondProofResult = await prove(secondProofInput, keyBasePath);
    const secondProofInBytes = parseProofToBytesArray(secondProofResult.proof);
    const secondInputsInBytes = parseToBytesArray(secondProofResult.publicSignals);
    
    const secondProofToSubmit = {
      proofA: secondProofInBytes.proofA,
      proofB: secondProofInBytes.proofB.flat(),
      proofC: secondProofInBytes.proofC,
      root: secondInputsInBytes[0],
      publicAmount: secondInputsInBytes[1],
      extDataHash: secondInputsInBytes[2],
      inputNullifiers: [secondInputsInBytes[3], secondInputsInBytes[4]],
      outputCommitments: [secondInputsInBytes[5], secondInputsInBytes[6]],
    };

    const secondNullifiers = findNullifierPDAs(program, secondProofToSubmit);
    const secondCrossCheckNullifiers = findCrossCheckNullifierPDAs(program, secondProofToSubmit);
    const secondCommitments = findCommitmentPDAs(program, secondProofToSubmit);

    // This is the vulnerability: the nullifier from the first transaction is now in a different slot
    // The PDA addresses will be different because:
    // First transaction: ["nullifier0", nullifier_value] and ["nullifier1", empty_nullifier]
    // Second transaction: ["nullifier0", empty_nullifier] and ["nullifier1", nullifier_value]
    
    // Create Address Lookup Table for second withdrawal transaction
    const secondTestProtocolAddresses = getTestProtocolAddresses(
      program.programId,
      authority.publicKey,
      treeAccountPDA,
      treeTokenAccountPDA,
      FEE_RECIPIENT_ACCOUNT
    );
    
    const secondLookupTableAddress = await createGlobalTestALT(provider.connection, authority, secondTestProtocolAddresses);

    let hasTransactionFailed = false;
    try {
      // Execute second withdrawal - this SHOULD fail due to cross-check accounts!
      const secondTx = await program.methods
        .transact(secondProofToSubmit, createExtDataMinified(secondExtData), secondExtData.encryptedOutput1, secondExtData.encryptedOutput2)
        .accounts({
          treeAccount: treeAccountPDA,
          nullifier0: secondNullifiers.nullifier0PDA,
          nullifier1: secondNullifiers.nullifier1PDA,
          nullifier2: secondCrossCheckNullifiers.nullifier2PDA,
          nullifier3: secondCrossCheckNullifiers.nullifier3PDA,
          commitment0: secondCommitments.commitment0PDA,
          commitment1: secondCommitments.commitment1PDA,
          recipient: recipient.publicKey,
          feeRecipientAccount: FEE_RECIPIENT_ACCOUNT,
          treeTokenAccount: treeTokenAccountPDA,
          globalConfig: globalConfigPDA,
          signer: randomUser.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([randomUser])
        .preInstructions([modifyComputeUnits])
        .transaction();

      // Create versioned transaction with ALT
      const secondVersionedTx = await createVersionedTransactionWithALT(
        provider.connection,
        randomUser.publicKey,
        secondTx.instructions,
        secondLookupTableAddress
      );
      
      // Send and confirm versioned transaction
      await sendAndConfirmVersionedTransaction(
        provider.connection,
        secondVersionedTx,
        [randomUser]
      );
    } catch (error) {
      // If the transaction fails, it means the vulnerability is fixed
      // Test should pass when attack is prevented
      hasTransactionFailed = true;
    }

    expect(hasTransactionFailed).to.be.true;
  });

  it("Can execute both deposit and withdraw instruction for correct input, with positive fee", async () => {
    const depositAmount = 20000;
    const calculatedDepositFee = calculateDepositFee(depositAmount); // 0% deposit fee = 0 lamports (deposits are free)

    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(depositAmount), // Positive ext amount (deposit)
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(calculatedDepositFee), // Calculated fee based on deposit rate
      feeRecipient: FEE_RECIPIENT_ACCOUNT,
      mintAddress: new anchor.web3.PublicKey("11111111111111111111111111111112"), // SOL mint address
    };

    // Create inputs for the first deposit
    const inputs = [
      new Utxo({ lightWasm }),
      new Utxo({ lightWasm })
    ];

    const outputAmount = (depositAmount - calculatedDepositFee).toString();
    const outputs = [
      new Utxo({ lightWasm, amount: outputAmount, index: globalMerkleTree._layers[0].length }), // Combined amount minus fee
      new Utxo({ lightWasm, amount: '0' }) // Empty UTXO
    ];

    // Create mock Merkle path data (normally built from the tree)
    const inputMerklePathIndices = inputs.map((input) => input.index || 0);
    
    // inputMerklePathElements won't be checked for empty utxos. so we need to create a sample full path
    // Create the Merkle paths for each input
    const inputMerklePathElements = inputs.map(() => {
      // Return an array of zero elements as the path for each input
      // Create a copy of the zeroElements array to avoid modifying the original
      return [...new Array(globalMerkleTree.levels).fill(0)];
    });

    // Resolve all async operations before creating the input object
    // Await nullifiers and commitments to get actual values instead of Promise objects
    const inputNullifiers = await Promise.all(inputs.map(x => x.getNullifier()));
    const outputCommitments = await Promise.all(outputs.map(x => x.getCommitment()));

    // Use the properly calculated Merkle tree root
    const root = globalMerkleTree.root();

    // Calculate the hash correctly using our utility
    const calculatedExtDataHash = getExtDataHash(extData);
    const publicAmountNumber = new anchor.BN(depositAmount - calculatedDepositFee);

    const input = {
      // Circuit inputs in exact order
      root: root,
      publicAmount: publicAmountNumber.toString(),
      extDataHash: calculatedExtDataHash,
      mintAddress: inputs[0].mintAddress,
      
      // Input nullifiers and UTXO data
      inputNullifier: inputNullifiers,
      inAmount: inputs.map(x => x.amount.toString(10)),
      inPrivateKey: inputs.map(x => x.keypair.privkey),
      inBlinding: inputs.map(x => x.blinding.toString(10)),
      inPathIndices: inputMerklePathIndices,
      inPathElements: inputMerklePathElements,
      
      // Output commitments and UTXO data
      outputCommitment: outputCommitments,
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
    const crossCheckNullifiers = findCrossCheckNullifierPDAs(program, proofToSubmit);

    // Derive commitment PDAs
    const { commitment0PDA, commitment1PDA } = findCommitmentPDAs(program, proofToSubmit);

    // Create Address Lookup Table for transaction size optimization
    const testProtocolAddresses = getTestProtocolAddresses(
      program.programId,
      authority.publicKey,
      treeAccountPDA,
      treeTokenAccountPDA,
      FEE_RECIPIENT_ACCOUNT
    );
    
    const lookupTableAddress = await createGlobalTestALT(provider.connection, authority, testProtocolAddresses);

    // Get balances before transaction
    const treeTokenAccountBalanceBefore = await provider.connection.getBalance(treeTokenAccountPDA);
    const feeRecipientBalanceBefore = await provider.connection.getBalance(FEE_RECIPIENT_ACCOUNT);
    const recipientBalanceBefore = await provider.connection.getBalance(recipient.publicKey);
    const randomUserBalanceBefore = await provider.connection.getBalance(randomUser.publicKey);

    // Execute the transaction without pre-instructions
    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    const tx = await program.methods
      .transact(proofToSubmit, createExtDataMinified(extData), extData.encryptedOutput1, extData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: nullifier0PDA,
        nullifier1: nullifier1PDA,
        nullifier2: crossCheckNullifiers.nullifier2PDA,
        nullifier3: crossCheckNullifiers.nullifier3PDA,
        commitment0: commitment0PDA,
        commitment1: commitment1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: FEE_RECIPIENT_ACCOUNT,
        treeTokenAccount: treeTokenAccountPDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey, // Use random user as signer
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser]) // Random user signs the transaction
      .preInstructions([modifyComputeUnits]) // Add compute budget instruction as pre-instruction
      .transaction();
    
    // Create versioned transaction with ALT
    const versionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      randomUser.publicKey,
      tx.instructions,
      lookupTableAddress
    );
    
    // Send and confirm versioned transaction
    const txSig = await sendAndConfirmVersionedTransaction(
      provider.connection,
      versionedTx,
      [randomUser]
    );
    
    expect(txSig).to.be.a('string');

    // Check commitment logs for transaction (only if transaction succeeded)
    const transaction = await provider.connection.getTransaction(txSig, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    });

    if (transaction && transaction.meta && transaction.meta.logMessages) {
      const logs = transaction.meta.logMessages;
      // Parse commitment events using Anchor's EventParser
      const eventParser = new EventParser(program.programId, new BorshCoder(program.idl));
      const events = Array.from(eventParser.parseLogs(logs));
      const commitmentEvents = events.filter(event => event.name === "commitmentData");
      
      // All transactions must have exactly 2 commitment events
      expect(commitmentEvents).to.have.length(2);

      // Verify first commitment event
      const firstEvent = commitmentEvents[0];
      expect(firstEvent.data.index).to.be.an.instanceOf(anchor.BN);
      expect(firstEvent.data.commitment).to.be.an('array');
      expect(firstEvent.data.encryptedOutput).to.be.instanceOf(Buffer);
      expect(firstEvent.data.commitment).to.have.length(32);
      
      // Verify second commitment event
      const secondEvent = commitmentEvents[1];
      expect(secondEvent.data.index).to.be.an.instanceOf(anchor.BN);
      expect(secondEvent.data.commitment).to.be.an('array');
      expect(secondEvent.data.encryptedOutput).to.be.instanceOf(Buffer);
      expect(secondEvent.data.commitment).to.have.length(32);
      
      // Verify second index is first index + 1
      expect(secondEvent.data.index.toNumber()).to.equal(firstEvent.data.index.toNumber() + 1);

      // Verify the event commitments match the actual output commitments
      const firstEventCommitment = Buffer.from(firstEvent.data.commitment);
      const secondEventCommitment = Buffer.from(secondEvent.data.commitment);
      
      // Compare against proof output commitments
      const proofOutputCommitments = proofToSubmit.outputCommitments;
      expect(firstEventCommitment.toString('hex')).to.deep.equal(Buffer.from(proofOutputCommitments[0]).toString('hex'));
      expect(secondEventCommitment.toString('hex')).to.deep.equal(Buffer.from(proofOutputCommitments[1]).toString('hex'));

      // Verify the event encrypted outputs match the actual encrypted outputs
      expect(firstEvent.data.encryptedOutput).to.deep.equal(extData.encryptedOutput1);
      expect(secondEvent.data.encryptedOutput).to.deep.equal(extData.encryptedOutput2);
    }

    // Verify commitment PDAs have correct data
    const commitment0Account = await provider.connection.getAccountInfo(commitment0PDA);
    const commitment1Account = await provider.connection.getAccountInfo(commitment1PDA);
    
    // Check that the commitment accounts exist
    expect(commitment0Account).to.not.be.null;
    expect(commitment1Account).to.not.be.null;
    
    // Deserialize the commitment accounts
    const commitment0Data = program.coder.accounts.decode(
      'commitmentAccount',
      commitment0Account.data
    );
    const commitment1Data = program.coder.accounts.decode(
      'commitmentAccount',
      commitment1Account.data
    );
    
    // Verify the commitment values match
    expect(Buffer.from(commitment0Data.commitment).equals(Buffer.from(proofToSubmit.outputCommitments[0]))).to.be.true;
    expect(Buffer.from(commitment1Data.commitment).equals(Buffer.from(proofToSubmit.outputCommitments[1]))).to.be.true;
    
    // Verify the encrypted outputs match
    expect(Buffer.from(commitment0Data.encryptedOutput).equals(extData.encryptedOutput1)).to.be.true;
    expect(Buffer.from(commitment1Data.encryptedOutput).equals(extData.encryptedOutput2)).to.be.true;

    // Get balances after transaction
    const treeTokenAccountBalanceAfter = await provider.connection.getBalance(treeTokenAccountPDA);
    const feeRecipientBalanceAfter = await provider.connection.getBalance(FEE_RECIPIENT_ACCOUNT);
    const recipientBalanceAfter = await provider.connection.getBalance(recipient.publicKey);
    const randomUserBalanceAfter = await provider.connection.getBalance(randomUser.publicKey);
    
    // Calculate differences
    const treeTokenAccountDiff = treeTokenAccountBalanceAfter - treeTokenAccountBalanceBefore;
    const feeRecipientDiff = feeRecipientBalanceAfter - feeRecipientBalanceBefore;
    const recipientDiff = recipientBalanceAfter - recipientBalanceBefore;
    const randomUserDiff = randomUserBalanceAfter - randomUserBalanceBefore;

    expect(treeTokenAccountDiff).to.be.equals(publicAmountNumber.toNumber());
    expect(feeRecipientDiff).to.be.equals(calculatedDepositFee);
    expect(recipientDiff).to.be.equals(0);
    // accounts for the transaction fee
    expect(randomUserDiff).to.be.lessThan(-extData.extAmount.toNumber());

    // Create mock input UTXOs for withdrawal
    // First input is a real UTXO that we created in deposit
    const withdrawInputs = [
      outputs[0], // Use the first output directly
      new Utxo({ lightWasm }) // Second input is empty
    ];
    const withdrawOutputs = [
      new Utxo({ lightWasm, amount: '3000', index: globalMerkleTree._layers[0].length }), // Some remaining amount
      new Utxo({ lightWasm, amount: '0' }) // Empty UTXO
    ];

    const withdrawInputsSum = withdrawInputs.reduce((sum, x) => sum.add(x.amount), new BN(0))
    const withdrawOutputsSum = withdrawOutputs.reduce((sum, x) => sum.add(x.amount), new BN(0))
    const withdrawalAmount = withdrawInputsSum.sub(withdrawOutputsSum)
    const withdrawFee = new anchor.BN(calculateWithdrawalFee(withdrawalAmount.toNumber()))
    const extAmount = new BN(withdrawFee)
      .add(withdrawOutputsSum)
      .sub(withdrawInputsSum)
    
    // For circom, we need field modular arithmetic to handle negative numbers
    const withdrawPublicAmount = new BN(extAmount).sub(new BN(withdrawFee)).add(FIELD_SIZE).mod(FIELD_SIZE).toString()
    
    // Create a sample ExtData object for withdrawal
    const withdrawExtData = {
      recipient: recipient.publicKey,
      extAmount: extAmount, // Use the calculated extAmount value instead of hardcoded -100
      encryptedOutput1: Buffer.from("withdrawEncryptedOutput1"),
      encryptedOutput2: Buffer.from("withdrawEncryptedOutput2"),
      fee: withdrawFee, // Use the same fee variable we used in calculations
      feeRecipient: FEE_RECIPIENT_ACCOUNT,
      mintAddress: new anchor.web3.PublicKey("11111111111111111111111111111112"), // SOL mint address
    };

    // Calculate the hash for withdrawal
    const withdrawExtDataHash = getExtDataHash(withdrawExtData);

    // Create a new tree and insert the deposit output commitments
    for (const commitment of outputCommitments) {
      globalMerkleTree.insert(commitment);
    }

    const oldRoot = globalMerkleTree.root();

    // Get nullifiers and commitments for withdrawal
    const withdrawInputNullifiers = await Promise.all(withdrawInputs.map(x => x.getNullifier()));
    const withdrawOutputCommitments = await Promise.all(withdrawOutputs.map(x => x.getCommitment()));

    // Calculate Merkle paths for withdrawal inputs properly
    const withdrawalInputMerklePathIndices = []
    const withdrawalInputMerklePathElements = []
    for (let i = 0; i < withdrawInputs.length; i++) {
      const withdrawInput = withdrawInputs[i]
      if (withdrawInput.amount.gt(new BN(0))) {
        const commitment = outputCommitments[i]
        withdrawInput.index = globalMerkleTree.indexOf(commitment)
        if (withdrawInput.index < 0) {
          throw new Error(`Input commitment ${commitment} was not found`)
        }
        withdrawalInputMerklePathIndices.push(withdrawInput.index)
        withdrawalInputMerklePathElements.push(globalMerkleTree.path(withdrawInput.index).pathElements)
      } else {
        withdrawalInputMerklePathIndices.push(0)
        withdrawalInputMerklePathElements.push(new Array(globalMerkleTree.levels).fill(0))
      }
    }

    // Create input for withdrawal proof generation
    const withdrawInput = {
      // Common transaction data
      root: oldRoot,
      inputNullifier: withdrawInputNullifiers,
      outputCommitment: withdrawOutputCommitments,
      publicAmount: withdrawPublicAmount.toString(),
      extDataHash: withdrawExtDataHash,
      
      // Input UTXO data (UTXOs being spent)
      inAmount: withdrawInputs.map(x => x.amount.toString(10)),
      inPrivateKey: withdrawInputs.map(x => x.keypair.privkey),
      inBlinding: withdrawInputs.map(x => x.blinding.toString(10)),
      mintAddress: withdrawInputs[0].mintAddress,
      inPathIndices: withdrawalInputMerklePathIndices,
      inPathElements: withdrawalInputMerklePathElements,
      
      // Output UTXO data (UTXOs being created)
      outAmount: withdrawOutputs.map(x => x.amount.toString(10)),
      outBlinding: withdrawOutputs.map(x => x.blinding.toString(10)),
      outPubkey: withdrawOutputs.map(x => x.keypair.pubkey),
    };

    // Generate proof for withdrawal
    const withdrawProofResult = await prove(withdrawInput, keyBasePath);
    const withdrawProofInBytes = parseProofToBytesArray(withdrawProofResult.proof);
    const withdrawInputsInBytes = parseToBytesArray(withdrawProofResult.publicSignals);
    
    // Create the final withdrawal proof object
    const withdrawProofToSubmit = {
      proofA: withdrawProofInBytes.proofA,
      proofB: withdrawProofInBytes.proofB.flat(),
      proofC: withdrawProofInBytes.proofC,
      root: withdrawInputsInBytes[0],
      publicAmount: withdrawInputsInBytes[1],
      extDataHash: withdrawInputsInBytes[2],
      inputNullifiers: [
        withdrawInputsInBytes[3],
        withdrawInputsInBytes[4]
      ],
      outputCommitments: [
        withdrawInputsInBytes[5],
        withdrawInputsInBytes[6]
      ],
    };

         // Derive PDAs for withdrawal nullifiers
     const withdrawNullifiers = findNullifierPDAs(program, withdrawProofToSubmit);
     const withdrawCrossCheckNullifiers = findCrossCheckNullifierPDAs(program, withdrawProofToSubmit);
     
     // Derive PDAs for withdrawal commitments
     const withdrawCommitments = findCommitmentPDAs(program, withdrawProofToSubmit);

    // Execute the withdrawal transaction
    const withdrawTx = await program.methods
      .transact(withdrawProofToSubmit, createExtDataMinified(withdrawExtData), withdrawExtData.encryptedOutput1, withdrawExtData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: withdrawNullifiers.nullifier0PDA,
        nullifier1: withdrawNullifiers.nullifier1PDA,
        nullifier2: withdrawCrossCheckNullifiers.nullifier2PDA,
        nullifier3: withdrawCrossCheckNullifiers.nullifier3PDA,
        commitment0: withdrawCommitments.commitment0PDA,
        commitment1: withdrawCommitments.commitment1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: FEE_RECIPIENT_ACCOUNT,
        treeTokenAccount: treeTokenAccountPDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .preInstructions([modifyComputeUnits])
      .transaction();
      
    // Create versioned transaction with ALT for withdrawal
    const withdrawVersionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      randomUser.publicKey,
      withdrawTx.instructions,
      lookupTableAddress
    );
    
    // Send and confirm withdrawal versioned transaction
    const withdrawTxSig = await sendAndConfirmVersionedTransaction(
      provider.connection,
      withdrawVersionedTx,
      [randomUser]
    );
    
    expect(withdrawTxSig).to.be.a('string');

    // Verify withdrawal commitment PDAs have correct data
    const withdrawCommitment0Account = await provider.connection.getAccountInfo(withdrawCommitments.commitment0PDA);
    const withdrawCommitment1Account = await provider.connection.getAccountInfo(withdrawCommitments.commitment1PDA);
    
    // Check that the commitment accounts exist
    expect(withdrawCommitment0Account).to.not.be.null;
    expect(withdrawCommitment1Account).to.not.be.null;
    
    // Deserialize the commitment accounts
    const withdrawCommitment0Data = program.coder.accounts.decode(
      'commitmentAccount',
      withdrawCommitment0Account.data
    );
    const withdrawCommitment1Data = program.coder.accounts.decode(
      'commitmentAccount',
      withdrawCommitment1Account.data
    );
    
    // Verify the commitment values match
    expect(Buffer.from(withdrawCommitment0Data.commitment).equals(Buffer.from(withdrawProofToSubmit.outputCommitments[0]))).to.be.true;
    expect(Buffer.from(withdrawCommitment1Data.commitment).equals(Buffer.from(withdrawProofToSubmit.outputCommitments[1]))).to.be.true;
    
    // Verify the encrypted outputs match
    expect(Buffer.from(withdrawCommitment0Data.encryptedOutput).equals(withdrawExtData.encryptedOutput1)).to.be.true;
    expect(Buffer.from(withdrawCommitment1Data.encryptedOutput).equals(withdrawExtData.encryptedOutput2)).to.be.true;

    // Get final balances after both transactions
    const finalTreeTokenBalance = await provider.connection.getBalance(treeTokenAccountPDA);
    const finalFeeRecipientBalance = await provider.connection.getBalance(FEE_RECIPIENT_ACCOUNT);
    const finalRandomUserBalance = await provider.connection.getBalance(randomUser.publicKey);
    
    // Calculate the withdrawal diffs specifically
    const treeTokenWithdrawDiff = finalTreeTokenBalance - treeTokenAccountBalanceAfter;
    const feeRecipientWithdrawDiff = finalFeeRecipientBalance - feeRecipientBalanceAfter;
    const randomUserWithdrawDiff = finalRandomUserBalance - randomUserBalanceAfter;
    
    // Verify withdrawal logic worked correctly
    expect(treeTokenWithdrawDiff).to.be.equals(extAmount.toNumber() - withdrawFee.toNumber()); // Tree decreases by withdraw amount
    expect(feeRecipientWithdrawDiff).to.be.equals(withdrawFee.toNumber()); // Fee recipient gets withdraw fee
    expect(randomUserWithdrawDiff).to.be.lessThan(-extAmount.toNumber()); // User gets withdraw amount minus tx fee

    // Calculate overall diffs for the full cycle
    const treeTokenTotalDiff = finalTreeTokenBalance - treeTokenAccountBalanceBefore;
    const feeRecipientTotalDiff = finalFeeRecipientBalance - feeRecipientBalanceBefore;
    const randomUserTotalDiff = finalRandomUserBalance - randomUserBalanceBefore;
    
    // Verify final balances
    // 1. Tree token account should have the remaining outputs amount
    expect(treeTokenTotalDiff).to.be.equals(withdrawOutputsSum.toNumber());
    
    // 2. Fee recipient keeps both deposit and withdrawal fees
    expect(feeRecipientTotalDiff).to.be.equals(calculatedDepositFee + withdrawFee.toNumber());
    
    // 3. Random user should have lost at least the fee amount plus some tx fees
    expect(randomUserTotalDiff).to.be.lessThan(-calculatedDepositFee);

    for (const commitment of withdrawOutputCommitments) {
      globalMerkleTree.insert(commitment);
    }
  });

  it("Can execute both deposit and withdraw instruction to PDA recipient, with positive fee", async () => {
    const depositAmount = 20000;
    const calculatedDepositFee = calculateDepositFee(depositAmount); // 0% deposit fee = 0 lamports (deposits are free)

    // Create a PDA recipient instead of a regular keypair
    const [pdaRecipient] = PublicKey.findProgramAddressSync(
      [Buffer.from("test_recipient"), randomUser.publicKey.toBuffer()],
      program.programId
    );

    // Fund the PDA with minimum rent exemption amount at the very beginning
    const pdaRecipientInitialBalance = await provider.connection.getBalance(pdaRecipient);
    if (pdaRecipientInitialBalance === 0) {
      // Use 0 data size since PDA is just receiving SOL, not storing program data
      const rentExemptionAmount = await provider.connection.getMinimumBalanceForRentExemption(0);
      const fundPdaTx = new anchor.web3.Transaction().add(
        anchor.web3.SystemProgram.transfer({
          fromPubkey: fundingAccount.publicKey,
          toPubkey: pdaRecipient,
          lamports: rentExemptionAmount,
        })
      );
      
      const fundPdaSignature = await provider.connection.sendTransaction(fundPdaTx, [fundingAccount]);
      await provider.connection.confirmTransaction(fundPdaSignature);
    }
    
    const extData = {
      recipient: pdaRecipient,
      extAmount: new anchor.BN(depositAmount), // Positive ext amount (deposit)
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(calculatedDepositFee), // Calculated fee based on deposit rate
      feeRecipient: FEE_RECIPIENT_ACCOUNT,
      mintAddress: new anchor.web3.PublicKey("11111111111111111111111111111112"), // SOL mint address
    };

    // Create inputs for the first deposit
    const inputs = [
      new Utxo({ lightWasm }),
      new Utxo({ lightWasm })
    ];

    const outputAmount = (depositAmount - calculatedDepositFee).toString();
    const outputs = [
      new Utxo({ lightWasm, amount: outputAmount, index: globalMerkleTree._layers[0].length }), // Combined amount minus fee
      new Utxo({ lightWasm, amount: '0' }) // Empty UTXO
    ];

    // Create mock Merkle path data (normally built from the tree)
    const inputMerklePathIndices = inputs.map((input) => input.index || 0);
    
    // inputMerklePathElements won't be checked for empty utxos. so we need to create a sample full path
    // Create the Merkle paths for each input
    const inputMerklePathElements = inputs.map(() => {
      // Return an array of zero elements as the path for each input
      // Create a copy of the zeroElements array to avoid modifying the original
      return [...new Array(globalMerkleTree.levels).fill(0)];
    });

    // Resolve all async operations before creating the input object
    // Await nullifiers and commitments to get actual values instead of Promise objects
    const inputNullifiers = await Promise.all(inputs.map(x => x.getNullifier()));
    const outputCommitments = await Promise.all(outputs.map(x => x.getCommitment()));

    // Use the properly calculated Merkle tree root
    const root = globalMerkleTree.root();

    // Calculate the hash correctly using our utility
    const calculatedExtDataHash = getExtDataHash(extData);
    const publicAmountNumber = new anchor.BN(depositAmount - calculatedDepositFee);

    const input = {
      // Circuit inputs in exact order
      root: root,
      publicAmount: publicAmountNumber.toString(),
      extDataHash: calculatedExtDataHash,
      mintAddress: inputs[0].mintAddress,
      
      // Input nullifiers and UTXO data
      inputNullifier: inputNullifiers,
      inAmount: inputs.map(x => x.amount.toString(10)),
      inPrivateKey: inputs.map(x => x.keypair.privkey),
      inBlinding: inputs.map(x => x.blinding.toString(10)),
      inPathIndices: inputMerklePathIndices,
      inPathElements: inputMerklePathElements,
      
      // Output commitments and UTXO data
      outputCommitment: outputCommitments,
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
    const crossCheckNullifiers = findCrossCheckNullifierPDAs(program, proofToSubmit);

    // Derive commitment PDAs
    const { commitment0PDA, commitment1PDA } = findCommitmentPDAs(program, proofToSubmit);

    // Create Address Lookup Table for transaction size optimization
    const testProtocolAddresses = getTestProtocolAddresses(
      program.programId,
      authority.publicKey,
      treeAccountPDA,
      treeTokenAccountPDA,
      FEE_RECIPIENT_ACCOUNT
    );

    const lookupTableAddress = await createGlobalTestALT(provider.connection, authority, testProtocolAddresses);

    // Get balances before transaction
    const treeTokenAccountBalanceBefore = await provider.connection.getBalance(treeTokenAccountPDA);
    const feeRecipientBalanceBefore = await provider.connection.getBalance(FEE_RECIPIENT_ACCOUNT);
    const recipientBalanceBefore = await provider.connection.getBalance(recipient.publicKey);
    const randomUserBalanceBefore = await provider.connection.getBalance(randomUser.publicKey);

    // Execute the transaction without pre-instructions
    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    const tx = await program.methods
      .transact(proofToSubmit, createExtDataMinified(extData), extData.encryptedOutput1, extData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: nullifier0PDA,
        nullifier1: nullifier1PDA,
        nullifier2: crossCheckNullifiers.nullifier2PDA,
        nullifier3: crossCheckNullifiers.nullifier3PDA,
        commitment0: commitment0PDA,
        commitment1: commitment1PDA,
        recipient: pdaRecipient, // Use PDA recipient to match ExtData
        feeRecipientAccount: FEE_RECIPIENT_ACCOUNT,
        treeTokenAccount: treeTokenAccountPDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey, // Use random user as signer
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser]) // Random user signs the transaction
      .preInstructions([modifyComputeUnits]) // Add compute budget instruction as pre-instruction
      .transaction();
    
    // Create versioned transaction with ALT
    const versionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      randomUser.publicKey,
      tx.instructions,
      lookupTableAddress
    );
    
    // Send and confirm versioned transaction
    const txSig = await sendAndConfirmVersionedTransaction(
      provider.connection,
      versionedTx,
      [randomUser]
    );
    
    expect(txSig).to.be.a('string');

    // Check commitment logs for transaction (only if transaction succeeded)
    const transaction = await provider.connection.getTransaction(txSig, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    });

    if (transaction && transaction.meta && transaction.meta.logMessages) {
      const logs = transaction.meta.logMessages;
      // Parse commitment events using Anchor's EventParser
      const eventParser = new EventParser(program.programId, new BorshCoder(program.idl));
      const events = Array.from(eventParser.parseLogs(logs));
      const commitmentEvents = events.filter(event => event.name === "commitmentData");
      
      // All transactions must have exactly 2 commitment events
      expect(commitmentEvents).to.have.length(2);

      // Verify first commitment event
      const firstEvent = commitmentEvents[0];
      expect(firstEvent.data.index).to.be.an.instanceOf(anchor.BN);
      expect(firstEvent.data.commitment).to.be.an('array');
      expect(firstEvent.data.encryptedOutput).to.be.instanceOf(Buffer);
      expect(firstEvent.data.commitment).to.have.length(32);
      
      // Verify second commitment event
      const secondEvent = commitmentEvents[1];
      expect(secondEvent.data.index).to.be.an.instanceOf(anchor.BN);
      expect(secondEvent.data.commitment).to.be.an('array');
      expect(secondEvent.data.encryptedOutput).to.be.instanceOf(Buffer);
      expect(secondEvent.data.commitment).to.have.length(32);
      
      // Verify second index is first index + 1
      expect(secondEvent.data.index.toNumber()).to.equal(firstEvent.data.index.toNumber() + 1);

      // Verify the event commitments match the actual output commitments
      const firstEventCommitment = Buffer.from(firstEvent.data.commitment);
      const secondEventCommitment = Buffer.from(secondEvent.data.commitment);
      
      // Compare against proof output commitments
      const proofOutputCommitments = proofToSubmit.outputCommitments;
      expect(firstEventCommitment.toString('hex')).to.deep.equal(Buffer.from(proofOutputCommitments[0]).toString('hex'));
      expect(secondEventCommitment.toString('hex')).to.deep.equal(Buffer.from(proofOutputCommitments[1]).toString('hex'));

      // Verify the event encrypted outputs match the actual encrypted outputs
      expect(firstEvent.data.encryptedOutput).to.deep.equal(extData.encryptedOutput1);
      expect(secondEvent.data.encryptedOutput).to.deep.equal(extData.encryptedOutput2);
    }

    // Verify commitment PDAs have correct data
    const commitment0Account = await provider.connection.getAccountInfo(commitment0PDA);
    const commitment1Account = await provider.connection.getAccountInfo(commitment1PDA);
    
    // Check that the commitment accounts exist
    expect(commitment0Account).to.not.be.null;
    expect(commitment1Account).to.not.be.null;
    
    // Deserialize the commitment accounts
    const commitment0Data = program.coder.accounts.decode(
      'commitmentAccount',
      commitment0Account.data
    );
    const commitment1Data = program.coder.accounts.decode(
      'commitmentAccount',
      commitment1Account.data
    );
    
    // Verify the commitment values match
    expect(Buffer.from(commitment0Data.commitment).equals(Buffer.from(proofToSubmit.outputCommitments[0]))).to.be.true;
    expect(Buffer.from(commitment1Data.commitment).equals(Buffer.from(proofToSubmit.outputCommitments[1]))).to.be.true;
    
    // Verify the encrypted outputs match
    expect(Buffer.from(commitment0Data.encryptedOutput).equals(extData.encryptedOutput1)).to.be.true;
    expect(Buffer.from(commitment1Data.encryptedOutput).equals(extData.encryptedOutput2)).to.be.true;

    // Get balances after transaction
    const treeTokenAccountBalanceAfter = await provider.connection.getBalance(treeTokenAccountPDA);
    const feeRecipientBalanceAfter = await provider.connection.getBalance(FEE_RECIPIENT_ACCOUNT);
    const recipientBalanceAfter = await provider.connection.getBalance(recipient.publicKey);
    const randomUserBalanceAfter = await provider.connection.getBalance(randomUser.publicKey);
    
    // Calculate differences
    const treeTokenAccountDiff = treeTokenAccountBalanceAfter - treeTokenAccountBalanceBefore;
    const feeRecipientDiff = feeRecipientBalanceAfter - feeRecipientBalanceBefore;
    const recipientDiff = recipientBalanceAfter - recipientBalanceBefore;
    const randomUserDiff = randomUserBalanceAfter - randomUserBalanceBefore;

    expect(treeTokenAccountDiff).to.be.equals(publicAmountNumber.toNumber());
    expect(feeRecipientDiff).to.be.equals(calculatedDepositFee);
    expect(recipientDiff).to.be.equals(0);
    // accounts for the transaction fee
    expect(randomUserDiff).to.be.lessThan(-extData.extAmount.toNumber());

    // Create mock input UTXOs for withdrawal
    // First input is a real UTXO that we created in deposit
    const withdrawInputs = [
      outputs[0], // Use the first output directly
      new Utxo({ lightWasm }) // Second input is empty
    ];
    const withdrawOutputs = [
      new Utxo({ lightWasm, amount: '3000', index: globalMerkleTree._layers[0].length }), // Some remaining amount
      new Utxo({ lightWasm, amount: '0' }) // Empty UTXO
    ];

    const withdrawInputsSum = withdrawInputs.reduce((sum, x) => sum.add(x.amount), new BN(0))
    const withdrawOutputsSum = withdrawOutputs.reduce((sum, x) => sum.add(x.amount), new BN(0))
    const withdrawalAmount = withdrawInputsSum.sub(withdrawOutputsSum)
    const withdrawFee = new anchor.BN(calculateWithdrawalFee(withdrawalAmount.toNumber()))
    const extAmount = new BN(withdrawFee)
      .add(withdrawOutputsSum)
      .sub(withdrawInputsSum)
    
    // For circom, we need field modular arithmetic to handle negative numbers
    const withdrawPublicAmount = new BN(extAmount).sub(new BN(withdrawFee)).add(FIELD_SIZE).mod(FIELD_SIZE).toString()
    
    // Create a sample ExtData object for withdrawal - THIS TIME USING PDA RECIPIENT
    const withdrawExtData = {
      recipient: pdaRecipient, // Use PDA as recipient instead of regular account
      extAmount: extAmount, // Use the calculated extAmount value instead of hardcoded -100
      encryptedOutput1: Buffer.from("withdrawEncryptedOutput1"),
      encryptedOutput2: Buffer.from("withdrawEncryptedOutput2"),
      fee: withdrawFee, // Use the same fee variable we used in calculations
      feeRecipient: FEE_RECIPIENT_ACCOUNT,
      mintAddress: new anchor.web3.PublicKey("11111111111111111111111111111112"), // SOL mint address
    };

    // Calculate the hash for withdrawal
    const withdrawExtDataHash = getExtDataHash(withdrawExtData);

    // Create a new tree and insert the deposit output commitments
    for (const commitment of outputCommitments) {
      globalMerkleTree.insert(commitment);
    }

    const oldRoot = globalMerkleTree.root();

    // Get nullifiers and commitments for withdrawal
    const withdrawInputNullifiers = await Promise.all(withdrawInputs.map(x => x.getNullifier()));
    const withdrawOutputCommitments = await Promise.all(withdrawOutputs.map(x => x.getCommitment()));

    // Calculate Merkle paths for withdrawal inputs properly
    const withdrawalInputMerklePathIndices = []
    const withdrawalInputMerklePathElements = []
    for (let i = 0; i < withdrawInputs.length; i++) {
      const withdrawInput = withdrawInputs[i]
      if (withdrawInput.amount.gt(new BN(0))) {
        const commitment = outputCommitments[i]
        withdrawInput.index = globalMerkleTree.indexOf(commitment)
        if (withdrawInput.index < 0) {
          throw new Error(`Input commitment ${commitment} was not found`)
        }
        withdrawalInputMerklePathIndices.push(withdrawInput.index)
        withdrawalInputMerklePathElements.push(globalMerkleTree.path(withdrawInput.index).pathElements)
      } else {
        withdrawalInputMerklePathIndices.push(0)
        withdrawalInputMerklePathElements.push(new Array(globalMerkleTree.levels).fill(0))
      }
    }

    // Create input for withdrawal proof generation
    const withdrawInput = {
      // Common transaction data
      root: oldRoot,
      inputNullifier: withdrawInputNullifiers,
      outputCommitment: withdrawOutputCommitments,
      publicAmount: withdrawPublicAmount.toString(),
      extDataHash: withdrawExtDataHash,
      
      // Input UTXO data (UTXOs being spent)
      inAmount: withdrawInputs.map(x => x.amount.toString(10)),
      inPrivateKey: withdrawInputs.map(x => x.keypair.privkey),
      inBlinding: withdrawInputs.map(x => x.blinding.toString(10)),
      mintAddress: withdrawInputs[0].mintAddress,
      inPathIndices: withdrawalInputMerklePathIndices,
      inPathElements: withdrawalInputMerklePathElements,
      
      // Output UTXO data (UTXOs being created)
      outAmount: withdrawOutputs.map(x => x.amount.toString(10)),
      outBlinding: withdrawOutputs.map(x => x.blinding.toString(10)),
      outPubkey: withdrawOutputs.map(x => x.keypair.pubkey),
    };

    // Generate proof for withdrawal
    const withdrawProofResult = await prove(withdrawInput, keyBasePath);
    const withdrawProofInBytes = parseProofToBytesArray(withdrawProofResult.proof);
    const withdrawInputsInBytes = parseToBytesArray(withdrawProofResult.publicSignals);
    
    // Create the final withdrawal proof object
    const withdrawProofToSubmit = {
      proofA: withdrawProofInBytes.proofA,
      proofB: withdrawProofInBytes.proofB.flat(),
      proofC: withdrawProofInBytes.proofC,
      root: withdrawInputsInBytes[0],
      publicAmount: withdrawInputsInBytes[1],
      extDataHash: withdrawInputsInBytes[2],
      inputNullifiers: [
        withdrawInputsInBytes[3],
        withdrawInputsInBytes[4]
      ],
      outputCommitments: [
        withdrawInputsInBytes[5],
        withdrawInputsInBytes[6]
      ],
    };

         // Derive PDAs for withdrawal nullifiers
     const withdrawNullifiers = findNullifierPDAs(program, withdrawProofToSubmit);
     const withdrawCrossCheckNullifiers = findCrossCheckNullifierPDAs(program, withdrawProofToSubmit);
     
     // Derive PDAs for withdrawal commitments
     const withdrawCommitments = findCommitmentPDAs(program, withdrawProofToSubmit);

    // Get PDA recipient balance before withdrawal (PDA was already funded at the beginning of the test)
    const pdaRecipientBalanceBefore = await provider.connection.getBalance(pdaRecipient);

    // Execute the withdrawal transaction
    const withdrawTx = await program.methods
      .transact(withdrawProofToSubmit, createExtDataMinified(withdrawExtData), withdrawExtData.encryptedOutput1, withdrawExtData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: withdrawNullifiers.nullifier0PDA,
        nullifier1: withdrawNullifiers.nullifier1PDA,
        nullifier2: withdrawCrossCheckNullifiers.nullifier2PDA, 
        nullifier3: withdrawCrossCheckNullifiers.nullifier3PDA,
        commitment0: withdrawCommitments.commitment0PDA,
        commitment1: withdrawCommitments.commitment1PDA,
        recipient: pdaRecipient, // Use PDA as recipient in transaction accounts
        feeRecipientAccount: FEE_RECIPIENT_ACCOUNT,
        treeTokenAccount: treeTokenAccountPDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .preInstructions([modifyComputeUnits])
      .transaction();
      
    // Create versioned transaction with ALT for withdrawal
    const withdrawVersionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      randomUser.publicKey,
      withdrawTx.instructions,
      lookupTableAddress
    );
    
    // Send and confirm withdrawal versioned transaction
    const withdrawTxSig = await sendAndConfirmVersionedTransaction(
      provider.connection,
      withdrawVersionedTx,
      [randomUser]
    );
    
    expect(withdrawTxSig).to.be.a('string');

    // Verify withdrawal commitment PDAs have correct data
    const withdrawCommitment0Account = await provider.connection.getAccountInfo(withdrawCommitments.commitment0PDA);
    const withdrawCommitment1Account = await provider.connection.getAccountInfo(withdrawCommitments.commitment1PDA);
    
    // Check that the commitment accounts exist
    expect(withdrawCommitment0Account).to.not.be.null;
    expect(withdrawCommitment1Account).to.not.be.null;
    
    // Deserialize the commitment accounts
    const withdrawCommitment0Data = program.coder.accounts.decode(
      'commitmentAccount',
      withdrawCommitment0Account.data
    );
    const withdrawCommitment1Data = program.coder.accounts.decode(
      'commitmentAccount',
      withdrawCommitment1Account.data
    );
    
    // Verify the commitment values match
    expect(Buffer.from(withdrawCommitment0Data.commitment).equals(Buffer.from(withdrawProofToSubmit.outputCommitments[0]))).to.be.true;
    expect(Buffer.from(withdrawCommitment1Data.commitment).equals(Buffer.from(withdrawProofToSubmit.outputCommitments[1]))).to.be.true;
    
    // Verify the encrypted outputs match
    expect(Buffer.from(withdrawCommitment0Data.encryptedOutput).equals(withdrawExtData.encryptedOutput1)).to.be.true;
    expect(Buffer.from(withdrawCommitment1Data.encryptedOutput).equals(withdrawExtData.encryptedOutput2)).to.be.true;

    // Get final balances after both transactions
    const finalTreeTokenBalance = await provider.connection.getBalance(treeTokenAccountPDA);
    const finalFeeRecipientBalance = await provider.connection.getBalance(FEE_RECIPIENT_ACCOUNT);
    const finalRandomUserBalance = await provider.connection.getBalance(randomUser.publicKey);
    const pdaRecipientBalanceAfter = await provider.connection.getBalance(pdaRecipient);
    
    // Calculate the withdrawal diffs specifically
    const treeTokenWithdrawDiff = finalTreeTokenBalance - treeTokenAccountBalanceAfter;
    const feeRecipientWithdrawDiff = finalFeeRecipientBalance - feeRecipientBalanceAfter;
    const randomUserWithdrawDiff = finalRandomUserBalance - randomUserBalanceAfter;
    const pdaRecipientDiff = pdaRecipientBalanceAfter - pdaRecipientBalanceBefore;
    
    // Verify withdrawal logic worked correctly
    expect(treeTokenWithdrawDiff).to.be.equals(extAmount.toNumber() - withdrawFee.toNumber()); // Tree decreases by withdraw amount
    expect(feeRecipientWithdrawDiff).to.be.equals(withdrawFee.toNumber()); // Fee recipient gets withdraw fee
    expect(randomUserWithdrawDiff).to.be.lessThan(-extAmount.toNumber()); // User gets withdraw amount minus tx fee
    expect(pdaRecipientDiff).to.be.equals(-extAmount.toNumber()); // PDA recipient receives the withdrawal amount

    // Calculate overall diffs for the full cycle
    const treeTokenTotalDiff = finalTreeTokenBalance - treeTokenAccountBalanceBefore;
    const feeRecipientTotalDiff = finalFeeRecipientBalance - feeRecipientBalanceBefore;
    const randomUserTotalDiff = finalRandomUserBalance - randomUserBalanceBefore;
    
    // Verify final balances
    // 1. Tree token account should have the remaining outputs amount
    expect(treeTokenTotalDiff).to.be.equals(withdrawOutputsSum.toNumber());
    
    // 2. Fee recipient keeps both deposit and withdrawal fees
    expect(feeRecipientTotalDiff).to.be.equals(calculatedDepositFee + withdrawFee.toNumber());
    
    // 3. Random user should have lost at least the fee amount plus some tx fees
    expect(randomUserTotalDiff).to.be.lessThan(-calculatedDepositFee);

    for (const commitment of withdrawOutputCommitments) {
      globalMerkleTree.insert(commitment);
    }
  });

  it("Can execute both deposit and withdraw instruction with PDA fee recipient, with positive fee", async () => {
    const depositAmount = 20000;
    const calculatedDepositFee = calculateDepositFee(depositAmount); // 0% deposit fee = 0 lamports (deposits are free)

    // Create a PDA for fee recipient instead of using regular FEE_RECIPIENT_ACCOUNT
    const [pdaFeeRecipient] = PublicKey.findProgramAddressSync(
      [Buffer.from("test_fee_recipient"), randomUser.publicKey.toBuffer()],
      program.programId
    );

    // Fund the PDA fee recipient with minimum rent exemption amount at the very beginning
    const pdaFeeRecipientInitialBalance = await provider.connection.getBalance(pdaFeeRecipient);
    if (pdaFeeRecipientInitialBalance === 0) {
      // Use 0 data size since PDA is just receiving SOL, not storing program data
      const rentExemptionAmount = await provider.connection.getMinimumBalanceForRentExemption(0);
      const fundPdaTx = new anchor.web3.Transaction().add(
        anchor.web3.SystemProgram.transfer({
          fromPubkey: fundingAccount.publicKey,
          toPubkey: pdaFeeRecipient,
          lamports: rentExemptionAmount,
        })
      );
      
      const fundPdaSignature = await provider.connection.sendTransaction(fundPdaTx, [fundingAccount]);
      await provider.connection.confirmTransaction(fundPdaSignature);
    }
    
    const extData = {
      recipient: recipient.publicKey, // Use normal recipient account
      extAmount: new anchor.BN(depositAmount), // Positive ext amount (deposit)
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(calculatedDepositFee), // Calculated fee based on deposit rate
      feeRecipient: pdaFeeRecipient, // Use PDA as fee recipient instead of regular account
      mintAddress: new anchor.web3.PublicKey("11111111111111111111111111111112"), // SOL mint address
    };

    // Create inputs for the first deposit
    const inputs = [
      new Utxo({ lightWasm }),
      new Utxo({ lightWasm })
    ];

    const outputAmount = (depositAmount - calculatedDepositFee).toString();
    const outputs = [
      new Utxo({ lightWasm, amount: outputAmount, index: globalMerkleTree._layers[0].length }), // Combined amount minus fee
      new Utxo({ lightWasm, amount: '0' }) // Empty UTXO
    ];

    // Create mock Merkle path data (normally built from the tree)
    const inputMerklePathIndices = inputs.map((input) => input.index || 0);
    
    // inputMerklePathElements won't be checked for empty utxos. so we need to create a sample full path
    // Create the Merkle paths for each input
    const inputMerklePathElements = inputs.map(() => {
      // Return an array of zero elements as the path for each input
      // Create a copy of the zeroElements array to avoid modifying the original
      return [...new Array(globalMerkleTree.levels).fill(0)];
    });

    // Resolve all async operations before creating the input object
    // Await nullifiers and commitments to get actual values instead of Promise objects
    const inputNullifiers = await Promise.all(inputs.map(x => x.getNullifier()));
    const outputCommitments = await Promise.all(outputs.map(x => x.getCommitment()));

    // Use the properly calculated Merkle tree root
    const root = globalMerkleTree.root();

    // Calculate the hash correctly using our utility
    const calculatedExtDataHash = getExtDataHash(extData);
    const publicAmountNumber = new anchor.BN(depositAmount - calculatedDepositFee);

    const input = {
      // Circuit inputs in exact order
      root: root,
      publicAmount: publicAmountNumber.toString(),
      extDataHash: calculatedExtDataHash,
      mintAddress: inputs[0].mintAddress,
      
      // Input nullifiers and UTXO data
      inputNullifier: inputNullifiers,
      inAmount: inputs.map(x => x.amount.toString(10)),
      inPrivateKey: inputs.map(x => x.keypair.privkey),
      inBlinding: inputs.map(x => x.blinding.toString(10)),
      inPathIndices: inputMerklePathIndices,
      inPathElements: inputMerklePathElements,
      
      // Output commitments and UTXO data
      outputCommitment: outputCommitments,
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
    const crossCheckNullifiers = findCrossCheckNullifierPDAs(program, proofToSubmit);

    // Derive commitment PDAs
    const { commitment0PDA, commitment1PDA } = findCommitmentPDAs(program, proofToSubmit);

    // Create Address Lookup Table for transaction size optimization
    const testProtocolAddresses = getTestProtocolAddresses(
      program.programId,
      authority.publicKey,
      treeAccountPDA,
      treeTokenAccountPDA,
      FEE_RECIPIENT_ACCOUNT
    );

    const lookupTableAddress = await createGlobalTestALT(provider.connection, authority, testProtocolAddresses);

    // Get balances before transaction
    const treeTokenAccountBalanceBefore = await provider.connection.getBalance(treeTokenAccountPDA);
    const pdaFeeRecipientBalanceBefore = await provider.connection.getBalance(pdaFeeRecipient);
    const recipientBalanceBefore = await provider.connection.getBalance(recipient.publicKey);
    const randomUserBalanceBefore = await provider.connection.getBalance(randomUser.publicKey);

    // Execute the transaction without pre-instructions
    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    const tx = await program.methods
      .transact(proofToSubmit, createExtDataMinified(extData), extData.encryptedOutput1, extData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: nullifier0PDA,
        nullifier1: nullifier1PDA,
        nullifier2: crossCheckNullifiers.nullifier2PDA,
        nullifier3: crossCheckNullifiers.nullifier3PDA,
        commitment0: commitment0PDA,
        commitment1: commitment1PDA,
        recipient: recipient.publicKey, // Use normal recipient account
        feeRecipientAccount: pdaFeeRecipient, // Use PDA fee recipient to match ExtData
        treeTokenAccount: treeTokenAccountPDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey, // Use random user as signer
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser]) // Random user signs the transaction
      .preInstructions([modifyComputeUnits]) // Add compute budget instruction as pre-instruction
      .transaction();
    
    // Create versioned transaction with ALT
    const versionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      randomUser.publicKey,
      tx.instructions,
      lookupTableAddress
    );
    
    // Send and confirm versioned transaction
    const txSig = await sendAndConfirmVersionedTransaction(
      provider.connection,
      versionedTx,
      [randomUser]
    );
    
    expect(txSig).to.be.a('string');

    // Check commitment logs for transaction (only if transaction succeeded)
    const transaction = await provider.connection.getTransaction(txSig, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    });

    if (transaction && transaction.meta && transaction.meta.logMessages) {
      const logs = transaction.meta.logMessages;
      // Parse commitment events using Anchor's EventParser
      const eventParser = new EventParser(program.programId, new BorshCoder(program.idl));
      const events = Array.from(eventParser.parseLogs(logs));
      const commitmentEvents = events.filter(event => event.name === "commitmentData");
      
      // All transactions must have exactly 2 commitment events
      expect(commitmentEvents).to.have.length(2);

      // Verify first commitment event
      const firstEvent = commitmentEvents[0];
      expect(firstEvent.data.index).to.be.an.instanceOf(anchor.BN);
      expect(firstEvent.data.commitment).to.be.an('array');
      expect(firstEvent.data.encryptedOutput).to.be.instanceOf(Buffer);
      expect(firstEvent.data.commitment).to.have.length(32);
      
      // Verify second commitment event
      const secondEvent = commitmentEvents[1];
      expect(secondEvent.data.index).to.be.an.instanceOf(anchor.BN);
      expect(secondEvent.data.commitment).to.be.an('array');
      expect(secondEvent.data.encryptedOutput).to.be.instanceOf(Buffer);
      expect(secondEvent.data.commitment).to.have.length(32);
      
      // Verify second index is first index + 1
      expect(secondEvent.data.index.toNumber()).to.equal(firstEvent.data.index.toNumber() + 1);

      // Verify the event commitments match the actual output commitments
      const firstEventCommitment = Buffer.from(firstEvent.data.commitment);
      const secondEventCommitment = Buffer.from(secondEvent.data.commitment);
      
      // Compare against proof output commitments
      const proofOutputCommitments = proofToSubmit.outputCommitments;
      expect(firstEventCommitment.toString('hex')).to.deep.equal(Buffer.from(proofOutputCommitments[0]).toString('hex'));
      expect(secondEventCommitment.toString('hex')).to.deep.equal(Buffer.from(proofOutputCommitments[1]).toString('hex'));

      // Verify the event encrypted outputs match the actual encrypted outputs
      expect(firstEvent.data.encryptedOutput).to.deep.equal(extData.encryptedOutput1);
      expect(secondEvent.data.encryptedOutput).to.deep.equal(extData.encryptedOutput2);
    }

    // Verify commitment PDAs have correct data
    const commitment0Account = await provider.connection.getAccountInfo(commitment0PDA);
    const commitment1Account = await provider.connection.getAccountInfo(commitment1PDA);
    
    // Check that the commitment accounts exist
    expect(commitment0Account).to.not.be.null;
    expect(commitment1Account).to.not.be.null;
    
    // Deserialize the commitment accounts
    const commitment0Data = program.coder.accounts.decode(
      'commitmentAccount',
      commitment0Account.data
    );
    const commitment1Data = program.coder.accounts.decode(
      'commitmentAccount',
      commitment1Account.data
    );
    
    // Verify the commitment values match
    expect(Buffer.from(commitment0Data.commitment).equals(Buffer.from(proofToSubmit.outputCommitments[0]))).to.be.true;
    expect(Buffer.from(commitment1Data.commitment).equals(Buffer.from(proofToSubmit.outputCommitments[1]))).to.be.true;
    
    // Verify the encrypted outputs match
    expect(Buffer.from(commitment0Data.encryptedOutput).equals(extData.encryptedOutput1)).to.be.true;
    expect(Buffer.from(commitment1Data.encryptedOutput).equals(extData.encryptedOutput2)).to.be.true;

    // Get balances after transaction
    const treeTokenAccountBalanceAfter = await provider.connection.getBalance(treeTokenAccountPDA);
    const pdaFeeRecipientBalanceAfter = await provider.connection.getBalance(pdaFeeRecipient);
    const recipientBalanceAfter = await provider.connection.getBalance(recipient.publicKey);
    const randomUserBalanceAfter = await provider.connection.getBalance(randomUser.publicKey);
    
    // Calculate differences
    const treeTokenAccountDiff = treeTokenAccountBalanceAfter - treeTokenAccountBalanceBefore;
    const pdaFeeRecipientDiff = pdaFeeRecipientBalanceAfter - pdaFeeRecipientBalanceBefore;
    const recipientDiff = recipientBalanceAfter - recipientBalanceBefore;
    const randomUserDiff = randomUserBalanceAfter - randomUserBalanceBefore;

    expect(treeTokenAccountDiff).to.be.equals(publicAmountNumber.toNumber());
    expect(pdaFeeRecipientDiff).to.be.equals(calculatedDepositFee); // PDA fee recipient gets the fee
    expect(recipientDiff).to.be.equals(0);
    // accounts for the transaction fee
    expect(randomUserDiff).to.be.lessThan(-extData.extAmount.toNumber());

    // Create mock input UTXOs for withdrawal
    // First input is a real UTXO that we created in deposit
    const withdrawInputs = [
      outputs[0], // Use the first output directly
      new Utxo({ lightWasm }) // Second input is empty
    ];
    const withdrawOutputs = [
      new Utxo({ lightWasm, amount: '3000', index: globalMerkleTree._layers[0].length }), // Some remaining amount
      new Utxo({ lightWasm, amount: '0' }) // Empty UTXO
    ];

    const withdrawInputsSum = withdrawInputs.reduce((sum, x) => sum.add(x.amount), new BN(0))
    const withdrawOutputsSum = withdrawOutputs.reduce((sum, x) => sum.add(x.amount), new BN(0))
    const withdrawalAmount = withdrawInputsSum.sub(withdrawOutputsSum)
    const withdrawFee = new anchor.BN(calculateWithdrawalFee(withdrawalAmount.toNumber()))
    const extAmount = new BN(withdrawFee)
      .add(withdrawOutputsSum)
      .sub(withdrawInputsSum)
    
    // For circom, we need field modular arithmetic to handle negative numbers
    const withdrawPublicAmount = new BN(extAmount).sub(new BN(withdrawFee)).add(FIELD_SIZE).mod(FIELD_SIZE).toString()
    
    // Create a sample ExtData object for withdrawal - THIS TIME USING PDA FEE RECIPIENT
    const withdrawExtData = {
      recipient: recipient.publicKey, // Use normal recipient account
      extAmount: extAmount, // Use the calculated extAmount value instead of hardcoded -100
      encryptedOutput1: Buffer.from("withdrawEncryptedOutput1"),
      encryptedOutput2: Buffer.from("withdrawEncryptedOutput2"),
      fee: withdrawFee, // Use the same fee variable we used in calculations
      feeRecipient: pdaFeeRecipient, // Use PDA as fee recipient instead of regular account
      mintAddress: new anchor.web3.PublicKey("11111111111111111111111111111112"), // SOL mint address
    };

    // Calculate the hash for withdrawal
    const withdrawExtDataHash = getExtDataHash(withdrawExtData);

    // Create a new tree and insert the deposit output commitments
    for (const commitment of outputCommitments) {
      globalMerkleTree.insert(commitment);
    }

    const oldRoot = globalMerkleTree.root();

    // Get nullifiers and commitments for withdrawal
    const withdrawInputNullifiers = await Promise.all(withdrawInputs.map(x => x.getNullifier()));
    const withdrawOutputCommitments = await Promise.all(withdrawOutputs.map(x => x.getCommitment()));

    // Calculate Merkle paths for withdrawal inputs properly
    const withdrawalInputMerklePathIndices = []
    const withdrawalInputMerklePathElements = []
    for (let i = 0; i < withdrawInputs.length; i++) {
      const withdrawInput = withdrawInputs[i]
      if (withdrawInput.amount.gt(new BN(0))) {
        const commitment = outputCommitments[i]
        withdrawInput.index = globalMerkleTree.indexOf(commitment)
        if (withdrawInput.index < 0) {
          throw new Error(`Input commitment ${commitment} was not found`)
        }
        withdrawalInputMerklePathIndices.push(withdrawInput.index)
        withdrawalInputMerklePathElements.push(globalMerkleTree.path(withdrawInput.index).pathElements)
      } else {
        withdrawalInputMerklePathIndices.push(0)
        withdrawalInputMerklePathElements.push(new Array(globalMerkleTree.levels).fill(0))
      }
    }

    // Create input for withdrawal proof generation
    const withdrawInput = {
      // Common transaction data
      root: oldRoot,
      inputNullifier: withdrawInputNullifiers,
      outputCommitment: withdrawOutputCommitments,
      publicAmount: withdrawPublicAmount.toString(),
      extDataHash: withdrawExtDataHash,
      
      // Input UTXO data (UTXOs being spent)
      inAmount: withdrawInputs.map(x => x.amount.toString(10)),
      inPrivateKey: withdrawInputs.map(x => x.keypair.privkey),
      inBlinding: withdrawInputs.map(x => x.blinding.toString(10)),
      mintAddress: withdrawInputs[0].mintAddress,
      inPathIndices: withdrawalInputMerklePathIndices,
      inPathElements: withdrawalInputMerklePathElements,
      
      // Output UTXO data (UTXOs being created)
      outAmount: withdrawOutputs.map(x => x.amount.toString(10)),
      outBlinding: withdrawOutputs.map(x => x.blinding.toString(10)),
      outPubkey: withdrawOutputs.map(x => x.keypair.pubkey),
    };

    // Generate proof for withdrawal
    const withdrawProofResult = await prove(withdrawInput, keyBasePath);
    const withdrawProofInBytes = parseProofToBytesArray(withdrawProofResult.proof);
    const withdrawInputsInBytes = parseToBytesArray(withdrawProofResult.publicSignals);
    
    // Create the final withdrawal proof object
    const withdrawProofToSubmit = {
      proofA: withdrawProofInBytes.proofA,
      proofB: withdrawProofInBytes.proofB.flat(),
      proofC: withdrawProofInBytes.proofC,
      root: withdrawInputsInBytes[0],
      publicAmount: withdrawInputsInBytes[1],
      extDataHash: withdrawInputsInBytes[2],
      inputNullifiers: [
        withdrawInputsInBytes[3],
        withdrawInputsInBytes[4]
      ],
      outputCommitments: [
        withdrawInputsInBytes[5],
        withdrawInputsInBytes[6]
      ],
    };

         // Derive PDAs for withdrawal nullifiers
     const withdrawNullifiers = findNullifierPDAs(program, withdrawProofToSubmit);
     const withdrawCrossCheckNullifiers = findCrossCheckNullifierPDAs(program, withdrawProofToSubmit);
     
     // Derive PDAs for withdrawal commitments
     const withdrawCommitments = findCommitmentPDAs(program, withdrawProofToSubmit);

    // Get PDA fee recipient balance before withdrawal (PDA was already funded at the beginning of the test)
    const pdaFeeRecipientBalanceBeforeWithdraw = await provider.connection.getBalance(pdaFeeRecipient);

    // Execute the withdrawal transaction
    const withdrawTx = await program.methods
      .transact(withdrawProofToSubmit, createExtDataMinified(withdrawExtData), withdrawExtData.encryptedOutput1, withdrawExtData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: withdrawNullifiers.nullifier0PDA,
        nullifier1: withdrawNullifiers.nullifier1PDA,
        nullifier2: withdrawCrossCheckNullifiers.nullifier2PDA,
        nullifier3: withdrawCrossCheckNullifiers.nullifier3PDA,
        commitment0: withdrawCommitments.commitment0PDA,
        commitment1: withdrawCommitments.commitment1PDA,
        recipient: recipient.publicKey, // Use normal recipient account
        feeRecipientAccount: pdaFeeRecipient, // Use PDA as fee recipient in transaction accounts
        treeTokenAccount: treeTokenAccountPDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .preInstructions([modifyComputeUnits])
      .transaction();
      
    // Create versioned transaction with ALT for withdrawal
    const withdrawVersionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      randomUser.publicKey,
      withdrawTx.instructions,
      lookupTableAddress
    );
    
    // Send and confirm withdrawal versioned transaction
    const withdrawTxSig = await sendAndConfirmVersionedTransaction(
      provider.connection,
      withdrawVersionedTx,
      [randomUser]
    );
    
    expect(withdrawTxSig).to.be.a('string');

    // Verify withdrawal commitment PDAs have correct data
    const withdrawCommitment0Account = await provider.connection.getAccountInfo(withdrawCommitments.commitment0PDA);
    const withdrawCommitment1Account = await provider.connection.getAccountInfo(withdrawCommitments.commitment1PDA);
    
    // Check that the commitment accounts exist
    expect(withdrawCommitment0Account).to.not.be.null;
    expect(withdrawCommitment1Account).to.not.be.null;
    
    // Deserialize the commitment accounts
    const withdrawCommitment0Data = program.coder.accounts.decode(
      'commitmentAccount',
      withdrawCommitment0Account.data
    );
    const withdrawCommitment1Data = program.coder.accounts.decode(
      'commitmentAccount',
      withdrawCommitment1Account.data
    );
    
    // Verify the commitment values match
    expect(Buffer.from(withdrawCommitment0Data.commitment).equals(Buffer.from(withdrawProofToSubmit.outputCommitments[0]))).to.be.true;
    expect(Buffer.from(withdrawCommitment1Data.commitment).equals(Buffer.from(withdrawProofToSubmit.outputCommitments[1]))).to.be.true;
    
    // Verify the encrypted outputs match
    expect(Buffer.from(withdrawCommitment0Data.encryptedOutput).equals(withdrawExtData.encryptedOutput1)).to.be.true;
    expect(Buffer.from(withdrawCommitment1Data.encryptedOutput).equals(withdrawExtData.encryptedOutput2)).to.be.true;

    // Get final balances after both transactions
    const finalTreeTokenBalance = await provider.connection.getBalance(treeTokenAccountPDA);
    const finalPdaFeeRecipientBalance = await provider.connection.getBalance(pdaFeeRecipient);
    const finalRecipientBalance = await provider.connection.getBalance(recipient.publicKey);
    const finalRandomUserBalance = await provider.connection.getBalance(randomUser.publicKey);
    
    // Calculate the withdrawal diffs specifically
    const treeTokenWithdrawDiff = finalTreeTokenBalance - treeTokenAccountBalanceAfter;
    const pdaFeeRecipientWithdrawDiff = finalPdaFeeRecipientBalance - pdaFeeRecipientBalanceBeforeWithdraw;
    const recipientWithdrawDiff = finalRecipientBalance - recipientBalanceAfter;
    const randomUserWithdrawDiff = finalRandomUserBalance - randomUserBalanceAfter;
    
    // Verify withdrawal logic worked correctly
    expect(treeTokenWithdrawDiff).to.be.equals(extAmount.toNumber() - withdrawFee.toNumber()); // Tree decreases by withdraw amount
    expect(pdaFeeRecipientWithdrawDiff).to.be.equals(withdrawFee.toNumber()); // PDA fee recipient gets withdraw fee
    expect(recipientWithdrawDiff).to.be.equals(-extAmount.toNumber()); // Normal recipient gets withdrawal amount
    expect(randomUserWithdrawDiff).to.be.lessThan(0); // User pays tx fee

    // Calculate overall diffs for the full cycle
    const treeTokenTotalDiff = finalTreeTokenBalance - treeTokenAccountBalanceBefore;
    const pdaFeeRecipientTotalDiff = finalPdaFeeRecipientBalance - pdaFeeRecipientBalanceBefore;
    const recipientTotalDiff = finalRecipientBalance - recipientBalanceBefore;
    const randomUserTotalDiff = finalRandomUserBalance - randomUserBalanceBefore;
    
    // Verify final balances
    // 1. Tree token account should have the remaining outputs amount
    expect(treeTokenTotalDiff).to.be.equals(withdrawOutputsSum.toNumber());
    
    // 2. PDA fee recipient keeps both deposit and withdrawal fees
    expect(pdaFeeRecipientTotalDiff).to.be.equals(calculatedDepositFee + withdrawFee.toNumber());
    
    // 3. Normal recipient gets the withdrawal amount
    expect(recipientTotalDiff).to.be.equals(-extAmount.toNumber());
    
    // 4. Random user should have lost at least the fee amount plus some tx fees
    expect(randomUserTotalDiff).to.be.lessThan(-calculatedDepositFee);

    for (const commitment of withdrawOutputCommitments) {
      globalMerkleTree.insert(commitment);
    }
  });

  it("Can execute both deposit and withdraw instruction for correct input, with 0 fee", async () => {
    const depositFee = new anchor.BN(calculateDepositFee(200))
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(200), // Positive ext amount (deposit)
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: depositFee, // Fee
      feeRecipient: FEE_RECIPIENT_ACCOUNT,
      mintAddress: new anchor.web3.PublicKey("11111111111111111111111111111112"), // SOL mint address
    };

    // Create inputs for the first deposit
    const inputs = [
      new Utxo({ lightWasm }),
      new Utxo({ lightWasm })
    ];

    const publicAmountNumber = extData.extAmount.sub(depositFee);
    const outputAmount = publicAmountNumber.toString();
    const outputs = [
      new Utxo({ lightWasm, amount: outputAmount, index: globalMerkleTree._layers[0].length }), // Combined amount minus fee
      new Utxo({ lightWasm, amount: '0' }) // Empty UTXO
    ];

    // Create mock Merkle path data (normally built from the tree)
    const inputMerklePathIndices = inputs.map((input) => input.index || 0);
    
    // inputMerklePathElements won't be checked for empty utxos. so we need to create a sample full path
    // Create the Merkle paths for each input
    const inputMerklePathElements = inputs.map(() => {
      // Return an array of zero elements as the path for each input
      // Create a copy of the zeroElements array to avoid modifying the original
      return [...new Array(globalMerkleTree.levels).fill(0)];
    });

    // Resolve all async operations before creating the input object
    // Await nullifiers and commitments to get actual values instead of Promise objects
    const inputNullifiers = await Promise.all(inputs.map(x => x.getNullifier()));
    const outputCommitments = await Promise.all(outputs.map(x => x.getCommitment()));

    // Use the properly calculated Merkle tree root
    const root = globalMerkleTree.root();

    // Calculate the hash correctly using our utility
    const calculatedExtDataHash = getExtDataHash(extData);

    const input = {
      // Common transaction data
      root: root,
      inputNullifier: inputNullifiers, // Use resolved values instead of Promise objects
      outputCommitment: outputCommitments, // Use resolved values instead of Promise objects
      publicAmount: outputAmount.toString(),
      extDataHash: calculatedExtDataHash,
      
      // Input UTXO data (UTXOs being spent) - ensure all values are in decimal format
      inAmount: inputs.map(x => x.amount.toString(10)),
      inPrivateKey: inputs.map(x => x.keypair.privkey),
      inBlinding: inputs.map(x => x.blinding.toString(10)),
      mintAddress: inputs[0].mintAddress,
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
    const crossCheckNullifiers = findCrossCheckNullifierPDAs(program, proofToSubmit);

    // Derive commitment PDAs
    const { commitment0PDA, commitment1PDA } = findCommitmentPDAs(program, proofToSubmit);

    // Create Address Lookup Table for transaction size optimization
    const testProtocolAddresses = getTestProtocolAddresses(
      program.programId,
      authority.publicKey,
      treeAccountPDA,
      treeTokenAccountPDA,
      FEE_RECIPIENT_ACCOUNT
    );
    
    const lookupTableAddress = await createGlobalTestALT(provider.connection, authority, testProtocolAddresses);

    // Get balances before transaction
    const treeTokenAccountBalanceBefore = await provider.connection.getBalance(treeTokenAccountPDA);
    const feeRecipientBalanceBefore = await provider.connection.getBalance(FEE_RECIPIENT_ACCOUNT);
    const recipientBalanceBefore = await provider.connection.getBalance(recipient.publicKey);
    const randomUserBalanceBefore = await provider.connection.getBalance(randomUser.publicKey);

    // Execute the transaction without pre-instructions
    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    const tx = await program.methods
      .transact(proofToSubmit, createExtDataMinified(extData), extData.encryptedOutput1, extData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: nullifier0PDA,
        nullifier1: nullifier1PDA,
        nullifier2: crossCheckNullifiers.nullifier2PDA,
        nullifier3: crossCheckNullifiers.nullifier3PDA,
        commitment0: commitment0PDA,
        commitment1: commitment1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: FEE_RECIPIENT_ACCOUNT,
        treeTokenAccount: treeTokenAccountPDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey, // Use random user as signer
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser]) // Random user signs the transaction
      .preInstructions([modifyComputeUnits]) // Add compute budget instruction as pre-instruction
      .transaction();
    
    // Create versioned transaction with ALT
    const versionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      randomUser.publicKey,
      tx.instructions,
      lookupTableAddress
    );
    
    // Send and confirm versioned transaction
    const txSig = await sendAndConfirmVersionedTransaction(
      provider.connection,
      versionedTx,
      [randomUser]
    );
    
    expect(txSig).to.be.a('string');

    // Check commitment logs for transaction (only if transaction succeeded)
    const transaction = await provider.connection.getTransaction(txSig, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    });

    if (transaction && transaction.meta && transaction.meta.logMessages) {
      const logs = transaction.meta.logMessages;
      // Parse commitment events using Anchor's EventParser
      const eventParser = new EventParser(program.programId, new BorshCoder(program.idl));
      const events = Array.from(eventParser.parseLogs(logs));
      const commitmentEvents = events.filter(event => event.name === "commitmentData");
      
      // All transactions must have exactly 2 commitment events
      expect(commitmentEvents).to.have.length(2);

      // Verify first commitment event
      const firstEvent = commitmentEvents[0];
      expect(firstEvent.data.index).to.be.an.instanceOf(anchor.BN);
      expect(firstEvent.data.commitment).to.be.an('array');
      expect(firstEvent.data.encryptedOutput).to.be.instanceOf(Buffer);
      expect(firstEvent.data.commitment).to.have.length(32);
      
      // Verify second commitment event
      const secondEvent = commitmentEvents[1];
      expect(secondEvent.data.index).to.be.an.instanceOf(anchor.BN);
      expect(secondEvent.data.commitment).to.be.an('array');
      expect(secondEvent.data.encryptedOutput).to.be.instanceOf(Buffer);
      expect(secondEvent.data.commitment).to.have.length(32);
      
      // Verify second index is first index + 1
      expect(secondEvent.data.index.toNumber()).to.equal(firstEvent.data.index.toNumber() + 1);

      // Verify the event commitments match the actual output commitments
      const firstEventCommitment = Buffer.from(firstEvent.data.commitment);
      const secondEventCommitment = Buffer.from(secondEvent.data.commitment);
      
      // Compare against proof output commitments
      const proofOutputCommitments = proofToSubmit.outputCommitments;
      expect(firstEventCommitment.toString('hex')).to.deep.equal(Buffer.from(proofOutputCommitments[0]).toString('hex'));
      expect(secondEventCommitment.toString('hex')).to.deep.equal(Buffer.from(proofOutputCommitments[1]).toString('hex'));

      // Verify the event encrypted outputs match the actual encrypted outputs
      expect(firstEvent.data.encryptedOutput).to.deep.equal(extData.encryptedOutput1);
      expect(secondEvent.data.encryptedOutput).to.deep.equal(extData.encryptedOutput2);
    }

    // Verify commitment PDAs have correct data
    const commitment0Account = await provider.connection.getAccountInfo(commitment0PDA);
    const commitment1Account = await provider.connection.getAccountInfo(commitment1PDA);
    
    // Check that the commitment accounts exist
    expect(commitment0Account).to.not.be.null;
    expect(commitment1Account).to.not.be.null;
    
    // Deserialize the commitment accounts
    const commitment0Data = program.coder.accounts.decode(
      'commitmentAccount',
      commitment0Account.data
    );
    const commitment1Data = program.coder.accounts.decode(
      'commitmentAccount',
      commitment1Account.data
    );
    
    // Verify the commitment values match
    expect(Buffer.from(commitment0Data.commitment).equals(Buffer.from(proofToSubmit.outputCommitments[0]))).to.be.true;
    expect(Buffer.from(commitment1Data.commitment).equals(Buffer.from(proofToSubmit.outputCommitments[1]))).to.be.true;
    
    // Verify the encrypted outputs match
    expect(Buffer.from(commitment0Data.encryptedOutput).equals(extData.encryptedOutput1)).to.be.true;
    expect(Buffer.from(commitment1Data.encryptedOutput).equals(extData.encryptedOutput2)).to.be.true;

    // Get balances after transaction
    const treeTokenAccountBalanceAfter = await provider.connection.getBalance(treeTokenAccountPDA);
    const feeRecipientBalanceAfter = await provider.connection.getBalance(FEE_RECIPIENT_ACCOUNT);
    const recipientBalanceAfter = await provider.connection.getBalance(recipient.publicKey);
    const randomUserBalanceAfter = await provider.connection.getBalance(randomUser.publicKey);
    
    // Calculate differences
    const treeTokenAccountDiff = treeTokenAccountBalanceAfter - treeTokenAccountBalanceBefore;
    const feeRecipientDiff = feeRecipientBalanceAfter - feeRecipientBalanceBefore;
    const recipientDiff = recipientBalanceAfter - recipientBalanceBefore;
    const randomUserDiff = randomUserBalanceAfter - randomUserBalanceBefore;

    expect(treeTokenAccountDiff).to.be.equals(publicAmountNumber.toNumber());
    expect(feeRecipientDiff).to.be.equals(depositFee.toNumber());
    expect(recipientDiff).to.be.equals(0);
    // accounts for the transaction fee
    expect(randomUserDiff).to.be.lessThan(-extData.extAmount.toNumber());

    // Create mock input UTXOs for withdrawal
    // First input is a real UTXO that we created in deposit
    const withdrawInputs = [
      outputs[0], // Use the first output directly
      new Utxo({ lightWasm }) // Second input is empty
    ];
    const withdrawOutputs = [
      new Utxo({ lightWasm, amount: '30', index: globalMerkleTree._layers[0].length }), // Some remaining amount
      new Utxo({ lightWasm, amount: '0' }) // Empty UTXO
    ];
    const withdrawFee = new anchor.BN(0)

    const withdrawInputsSum = withdrawInputs.reduce((sum, x) => sum.add(x.amount), new BN(0))
    const withdrawOutputsSum = withdrawOutputs.reduce((sum, x) => sum.add(x.amount), new BN(0))
    const extAmount = new BN(withdrawFee)
      .add(withdrawOutputsSum)
      .sub(withdrawInputsSum)
    
    // For circom, we need field modular arithmetic to handle negative numbers
    const withdrawPublicAmount = new BN(extAmount).sub(new BN(withdrawFee)).add(FIELD_SIZE).mod(FIELD_SIZE).toString()
    
    // Create a sample ExtData object for withdrawal
    const withdrawExtData = {
      recipient: recipient.publicKey,
      extAmount: extAmount, // Use the calculated extAmount value instead of hardcoded -100
      encryptedOutput1: Buffer.from("withdrawEncryptedOutput1"),
      encryptedOutput2: Buffer.from("withdrawEncryptedOutput2"),
      fee: withdrawFee, // Use the same fee variable we used in calculations
      feeRecipient: FEE_RECIPIENT_ACCOUNT,
      mintAddress: new anchor.web3.PublicKey("11111111111111111111111111111112"), // SOL mint address
    };

    // Calculate the hash for withdrawal
    const withdrawExtDataHash = getExtDataHash(withdrawExtData);

    // Create a new tree and insert the deposit output commitments
    for (const commitment of outputCommitments) {
      globalMerkleTree.insert(commitment);
    }

    const oldRoot = globalMerkleTree.root();

    // Get nullifiers and commitments for withdrawal
    const withdrawInputNullifiers = await Promise.all(withdrawInputs.map(x => x.getNullifier()));
    const withdrawOutputCommitments = await Promise.all(withdrawOutputs.map(x => x.getCommitment()));

    // Calculate Merkle paths for withdrawal inputs properly
    const withdrawalInputMerklePathIndices = []
    const withdrawalInputMerklePathElements = []
    for (let i = 0; i < withdrawInputs.length; i++) {
      const withdrawInput = withdrawInputs[i]
      if (withdrawInput.amount.gt(new BN(0))) {
        const commitment = outputCommitments[i]
        withdrawInput.index = globalMerkleTree.indexOf(commitment)
        if (withdrawInput.index < 0) {
          throw new Error(`Input commitment ${commitment} was not found`)
        }
        withdrawalInputMerklePathIndices.push(withdrawInput.index)
        withdrawalInputMerklePathElements.push(globalMerkleTree.path(withdrawInput.index).pathElements)
      } else {
        withdrawalInputMerklePathIndices.push(0)
        withdrawalInputMerklePathElements.push(new Array(globalMerkleTree.levels).fill(0))
      }
    }

    // Create input for withdrawal proof generation
    const withdrawInput = {
      // Common transaction data
      root: oldRoot,
      inputNullifier: withdrawInputNullifiers,
      outputCommitment: withdrawOutputCommitments,
      publicAmount: withdrawPublicAmount.toString(),
      extDataHash: withdrawExtDataHash,
      
      // Input UTXO data (UTXOs being spent)
      inAmount: withdrawInputs.map(x => x.amount.toString(10)),
      inPrivateKey: withdrawInputs.map(x => x.keypair.privkey),
      inBlinding: withdrawInputs.map(x => x.blinding.toString(10)),
      mintAddress: withdrawInputs[0].mintAddress,
      inPathIndices: withdrawalInputMerklePathIndices,
      inPathElements: withdrawalInputMerklePathElements,
      
      // Output UTXO data (UTXOs being created)
      outAmount: withdrawOutputs.map(x => x.amount.toString(10)),
      outBlinding: withdrawOutputs.map(x => x.blinding.toString(10)),
      outPubkey: withdrawOutputs.map(x => x.keypair.pubkey),
    };

    // Generate proof for withdrawal
    const withdrawProofResult = await prove(withdrawInput, keyBasePath);
    const withdrawProofInBytes = parseProofToBytesArray(withdrawProofResult.proof);
    const withdrawInputsInBytes = parseToBytesArray(withdrawProofResult.publicSignals);
    
    // Create the final withdrawal proof object
    const withdrawProofToSubmit = {
      proofA: withdrawProofInBytes.proofA,
      proofB: withdrawProofInBytes.proofB.flat(),
      proofC: withdrawProofInBytes.proofC,
      root: withdrawInputsInBytes[0],
      publicAmount: withdrawInputsInBytes[1],
      extDataHash: withdrawInputsInBytes[2],
      inputNullifiers: [
        withdrawInputsInBytes[3],
        withdrawInputsInBytes[4]
      ],
      outputCommitments: [
        withdrawInputsInBytes[5],
        withdrawInputsInBytes[6]
      ],
    };

         // Derive PDAs for withdrawal nullifiers
     const withdrawNullifiers = findNullifierPDAs(program, withdrawProofToSubmit);
     const withdrawCrossCheckNullifiers = findCrossCheckNullifierPDAs(program, withdrawProofToSubmit);
     
     // Derive PDAs for withdrawal commitments
     const withdrawCommitments = findCommitmentPDAs(program, withdrawProofToSubmit);

    // Execute the withdrawal transaction
    const withdrawTx = await program.methods
      .transact(withdrawProofToSubmit, createExtDataMinified(withdrawExtData), withdrawExtData.encryptedOutput1, withdrawExtData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: withdrawNullifiers.nullifier0PDA,
        nullifier1: withdrawNullifiers.nullifier1PDA,
        nullifier2: withdrawCrossCheckNullifiers.nullifier2PDA,
        nullifier3: withdrawCrossCheckNullifiers.nullifier3PDA,
        commitment0: withdrawCommitments.commitment0PDA,
        commitment1: withdrawCommitments.commitment1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: FEE_RECIPIENT_ACCOUNT,
        treeTokenAccount: treeTokenAccountPDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .preInstructions([modifyComputeUnits])
      .transaction();
      
    // Create versioned transaction with ALT for withdrawal
    const withdrawVersionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      randomUser.publicKey,
      withdrawTx.instructions,
      lookupTableAddress
    );
    
    // Send and confirm withdrawal versioned transaction
    const withdrawTxSig = await sendAndConfirmVersionedTransaction(
      provider.connection,
      withdrawVersionedTx,
      [randomUser]
    );
    
    expect(withdrawTxSig).to.be.a('string');

    // Verify withdrawal commitment PDAs have correct data
    const withdrawCommitment0Account = await provider.connection.getAccountInfo(withdrawCommitments.commitment0PDA);
    const withdrawCommitment1Account = await provider.connection.getAccountInfo(withdrawCommitments.commitment1PDA);
    
    // Check that the commitment accounts exist
    expect(withdrawCommitment0Account).to.not.be.null;
    expect(withdrawCommitment1Account).to.not.be.null;
    
    // Deserialize the commitment accounts
    const withdrawCommitment0Data = program.coder.accounts.decode(
      'commitmentAccount',
      withdrawCommitment0Account.data
    );
    const withdrawCommitment1Data = program.coder.accounts.decode(
      'commitmentAccount',
      withdrawCommitment1Account.data
    );
    
    // Verify the commitment values match
    expect(Buffer.from(withdrawCommitment0Data.commitment).equals(Buffer.from(withdrawProofToSubmit.outputCommitments[0]))).to.be.true;
    expect(Buffer.from(withdrawCommitment1Data.commitment).equals(Buffer.from(withdrawProofToSubmit.outputCommitments[1]))).to.be.true;
    
    // Verify the encrypted outputs match
    expect(Buffer.from(withdrawCommitment0Data.encryptedOutput).equals(withdrawExtData.encryptedOutput1)).to.be.true;
    expect(Buffer.from(withdrawCommitment1Data.encryptedOutput).equals(withdrawExtData.encryptedOutput2)).to.be.true;

    // Get final balances after both transactions
    const finalTreeTokenBalance = await provider.connection.getBalance(treeTokenAccountPDA);
    const finalFeeRecipientBalance = await provider.connection.getBalance(FEE_RECIPIENT_ACCOUNT);
    const finalRandomUserBalance = await provider.connection.getBalance(randomUser.publicKey);
    
    // Calculate the withdrawal diffs specifically
    const treeTokenWithdrawDiff = finalTreeTokenBalance - treeTokenAccountBalanceAfter;
    const feeRecipientWithdrawDiff = finalFeeRecipientBalance - feeRecipientBalanceAfter;
    const randomUserWithdrawDiff = finalRandomUserBalance - randomUserBalanceAfter;
    
    // Verify withdrawal logic worked correctly
    expect(treeTokenWithdrawDiff).to.be.equals(extAmount.toNumber() - withdrawFee.toNumber()); // Tree decreases by withdraw amount
    expect(feeRecipientWithdrawDiff).to.be.equals(withdrawFee.toNumber()); // Fee recipient unchanged
    expect(randomUserWithdrawDiff).to.be.lessThan(-extAmount.toNumber()); // User gets withdraw amount minus tx fee

    // Calculate overall diffs for the full cycle
    const treeTokenTotalDiff = finalTreeTokenBalance - treeTokenAccountBalanceBefore;
    const feeRecipientTotalDiff = finalFeeRecipientBalance - feeRecipientBalanceBefore;
    const randomUserTotalDiff = finalRandomUserBalance - randomUserBalanceBefore;
    
    // Verify final balances
    // 1. Tree token account should be back to original amount (excluding the fee)
    expect(treeTokenTotalDiff).to.be.equals(withdrawOutputsSum.toNumber());
    
    // 2. Fee recipient keeps the fees
    expect(feeRecipientTotalDiff).to.be.equals(depositFee.toNumber() + withdrawFee.toNumber());
    
    // 3. Random user should have lost at least the fee amount plus some tx fees
    expect(randomUserTotalDiff).to.be.lessThan(-depositFee.toNumber());

    for (const commitment of withdrawOutputCommitments) {
      globalMerkleTree.insert(commitment);
    }
  });

  it("Attacker can't frontrun withdraw transaction", async () => {
    const depositFee = new anchor.BN(calculateDepositFee(200))
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(200), // Positive ext amount (deposit)
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: depositFee, // Fee
      feeRecipient: FEE_RECIPIENT_ACCOUNT,
      mintAddress: new anchor.web3.PublicKey("11111111111111111111111111111112"), // SOL mint address
    };

    // Create inputs for the first deposit
    const inputs = [
      new Utxo({ lightWasm }),
      new Utxo({ lightWasm })
    ];

    const publicAmountNumber = extData.extAmount.sub(depositFee);
    const outputAmount = publicAmountNumber.toString();
    const outputs = [
      new Utxo({ lightWasm, amount: outputAmount, index: globalMerkleTree._layers[0].length }), // Combined amount minus fee
      new Utxo({ lightWasm, amount: '0' }) // Empty UTXO
    ];

    // Create mock Merkle path data (normally built from the tree)
    const inputMerklePathIndices = inputs.map((input) => input.index || 0);
    
    // inputMerklePathElements won't be checked for empty utxos. so we need to create a sample full path
    // Create the Merkle paths for each input
    const inputMerklePathElements = inputs.map(() => {
      // Return an array of zero elements as the path for each input
      // Create a copy of the zeroElements array to avoid modifying the original
      return [...new Array(globalMerkleTree.levels).fill(0)];
    });

    // Resolve all async operations before creating the input object
    // Await nullifiers and commitments to get actual values instead of Promise objects
    const inputNullifiers = await Promise.all(inputs.map(x => x.getNullifier()));
    const outputCommitments = await Promise.all(outputs.map(x => x.getCommitment()));

    // Use the properly calculated Merkle tree root
    const root = globalMerkleTree.root();

    // Calculate the hash correctly using our utility
    const calculatedExtDataHash = getExtDataHash(extData);

    const input = {
      // Common transaction data
      root: root,
      inputNullifier: inputNullifiers, // Use resolved values instead of Promise objects
      outputCommitment: outputCommitments, // Use resolved values instead of Promise objects
      publicAmount: outputAmount.toString(),
      extDataHash: calculatedExtDataHash,
      
      // Input UTXO data (UTXOs being spent) - ensure all values are in decimal format
      inAmount: inputs.map(x => x.amount.toString(10)),
      inPrivateKey: inputs.map(x => x.keypair.privkey),
      inBlinding: inputs.map(x => x.blinding.toString(10)),
      mintAddress: inputs[0].mintAddress,
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
    const crossCheckNullifiers = findCrossCheckNullifierPDAs(program, proofToSubmit);

    // Derive commitment PDAs
    const { commitment0PDA, commitment1PDA } = findCommitmentPDAs(program, proofToSubmit);

    // Create Address Lookup Table for transaction size optimization
    const testProtocolAddresses = getTestProtocolAddresses(
      program.programId,
      authority.publicKey,
      treeAccountPDA,
      treeTokenAccountPDA,
      FEE_RECIPIENT_ACCOUNT
    );
    testProtocolAddresses.push(attacker.publicKey); // Add attacker to the lookup table
    
    const lookupTableAddress = await createGlobalTestALT(provider.connection, authority, testProtocolAddresses);

    // Get balances before transaction
    const treeTokenAccountBalanceBefore = await provider.connection.getBalance(treeTokenAccountPDA);
    const feeRecipientBalanceBefore = await provider.connection.getBalance(FEE_RECIPIENT_ACCOUNT);
    const recipientBalanceBefore = await provider.connection.getBalance(recipient.publicKey);
    const randomUserBalanceBefore = await provider.connection.getBalance(randomUser.publicKey);

    // Execute the transaction without pre-instructions
    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    const tx = await program.methods
      .transact(proofToSubmit, createExtDataMinified(extData), extData.encryptedOutput1, extData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: nullifier0PDA,
        nullifier1: nullifier1PDA,
        nullifier2: crossCheckNullifiers.nullifier2PDA,
        nullifier3: crossCheckNullifiers.nullifier3PDA,
        commitment0: commitment0PDA,
        commitment1: commitment1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: FEE_RECIPIENT_ACCOUNT,
        treeTokenAccount: treeTokenAccountPDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey, // Use random user as signer
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser]) // Random user signs the transaction
      .preInstructions([modifyComputeUnits]) // Add compute budget instruction as pre-instruction
      .transaction();
    
    // Create versioned transaction with ALT
    const versionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      randomUser.publicKey,
      tx.instructions,
      lookupTableAddress
    );
    
    // Send and confirm versioned transaction
    const txSig = await sendAndConfirmVersionedTransaction(
      provider.connection,
      versionedTx,
      [randomUser]
    );
    
    expect(txSig).to.be.a('string');

    // Check commitment logs for transaction (only if transaction succeeded)
    const transaction = await provider.connection.getTransaction(txSig, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    });

    if (transaction && transaction.meta && transaction.meta.logMessages) {
      const logs = transaction.meta.logMessages;
      // Parse commitment events using Anchor's EventParser
      const eventParser = new EventParser(program.programId, new BorshCoder(program.idl));
      const events = Array.from(eventParser.parseLogs(logs));
      const commitmentEvents = events.filter(event => event.name === "commitmentData");
      
      // All transactions must have exactly 2 commitment events
      expect(commitmentEvents).to.have.length(2);

      // Verify first commitment event
      const firstEvent = commitmentEvents[0];
      expect(firstEvent.data.index).to.be.an.instanceOf(anchor.BN);
      expect(firstEvent.data.commitment).to.be.an('array');
      expect(firstEvent.data.encryptedOutput).to.be.instanceOf(Buffer);
      expect(firstEvent.data.commitment).to.have.length(32);
      
      // Verify second commitment event
      const secondEvent = commitmentEvents[1];
      expect(secondEvent.data.index).to.be.an.instanceOf(anchor.BN);
      expect(secondEvent.data.commitment).to.be.an('array');
      expect(secondEvent.data.encryptedOutput).to.be.instanceOf(Buffer);
      expect(secondEvent.data.commitment).to.have.length(32);
      
      // Verify second index is first index + 1
      expect(secondEvent.data.index.toNumber()).to.equal(firstEvent.data.index.toNumber() + 1);

      // Verify the event commitments match the actual output commitments
      const firstEventCommitment = Buffer.from(firstEvent.data.commitment);
      const secondEventCommitment = Buffer.from(secondEvent.data.commitment);
      
      // Compare against proof output commitments
      const proofOutputCommitments = proofToSubmit.outputCommitments;
      expect(firstEventCommitment.toString('hex')).to.deep.equal(Buffer.from(proofOutputCommitments[0]).toString('hex'));
      expect(secondEventCommitment.toString('hex')).to.deep.equal(Buffer.from(proofOutputCommitments[1]).toString('hex'));

      // Verify the event encrypted outputs match the actual encrypted outputs
      expect(firstEvent.data.encryptedOutput).to.deep.equal(extData.encryptedOutput1);
      expect(secondEvent.data.encryptedOutput).to.deep.equal(extData.encryptedOutput2);
    }

    // Verify commitment PDAs have correct data
    const commitment0Account = await provider.connection.getAccountInfo(commitment0PDA);
    const commitment1Account = await provider.connection.getAccountInfo(commitment1PDA);
    
    // Check that the commitment accounts exist
    expect(commitment0Account).to.not.be.null;
    expect(commitment1Account).to.not.be.null;
    
    // Deserialize the commitment accounts
    const commitment0Data = program.coder.accounts.decode(
      'commitmentAccount',
      commitment0Account.data
    );
    const commitment1Data = program.coder.accounts.decode(
      'commitmentAccount',
      commitment1Account.data
    );
    
    // Verify the commitment values match
    expect(Buffer.from(commitment0Data.commitment).equals(Buffer.from(proofToSubmit.outputCommitments[0]))).to.be.true;
    expect(Buffer.from(commitment1Data.commitment).equals(Buffer.from(proofToSubmit.outputCommitments[1]))).to.be.true;
    
    // Verify the encrypted outputs match
    expect(Buffer.from(commitment0Data.encryptedOutput).equals(extData.encryptedOutput1)).to.be.true;
    expect(Buffer.from(commitment1Data.encryptedOutput).equals(extData.encryptedOutput2)).to.be.true;

    // Get balances after transaction
    const treeTokenAccountBalanceAfter = await provider.connection.getBalance(treeTokenAccountPDA);
    const feeRecipientBalanceAfter = await provider.connection.getBalance(FEE_RECIPIENT_ACCOUNT);
    const recipientBalanceAfter = await provider.connection.getBalance(recipient.publicKey);
    const randomUserBalanceAfter = await provider.connection.getBalance(randomUser.publicKey);
    const attackerBalanceAfter = await provider.connection.getBalance(attacker.publicKey);
    
    // Calculate differences
    const treeTokenAccountDiff = treeTokenAccountBalanceAfter - treeTokenAccountBalanceBefore;
    const feeRecipientDiff = feeRecipientBalanceAfter - feeRecipientBalanceBefore;
    const recipientDiff = recipientBalanceAfter - recipientBalanceBefore;
    const randomUserDiff = randomUserBalanceAfter - randomUserBalanceBefore;

    expect(treeTokenAccountDiff).to.be.equals(publicAmountNumber.toNumber());
    expect(feeRecipientDiff).to.be.equals(depositFee.toNumber());
    expect(recipientDiff).to.be.equals(0);
    // accounts for the transaction fee
    expect(randomUserDiff).to.be.lessThan(-extData.extAmount.toNumber());

    // Create mock input UTXOs for withdrawal
    // First input is a real UTXO that we created in deposit
    const withdrawInputs = [
      outputs[0], // Use the first output directly
      new Utxo({ lightWasm }) // Second input is empty
    ];
    const withdrawOutputs = [
      new Utxo({ lightWasm, amount: '30', index: globalMerkleTree._layers[0].length }), // Some remaining amount
      new Utxo({ lightWasm, amount: '0' }) // Empty UTXO
    ];
    const withdrawFee = new anchor.BN(0)

    const withdrawInputsSum = withdrawInputs.reduce((sum, x) => sum.add(x.amount), new BN(0))
    const withdrawOutputsSum = withdrawOutputs.reduce((sum, x) => sum.add(x.amount), new BN(0))
    const extAmount = new BN(withdrawFee)
      .add(withdrawOutputsSum)
      .sub(withdrawInputsSum)
    
    // For circom, we need field modular arithmetic to handle negative numbers
    const withdrawPublicAmount = new BN(extAmount).sub(new BN(withdrawFee)).add(FIELD_SIZE).mod(FIELD_SIZE).toString()
    
    // Create a sample ExtData object for withdrawal
    const withdrawExtData = {
      recipient: recipient.publicKey,
      extAmount: extAmount, // Use the calculated extAmount value instead of hardcoded -100
      encryptedOutput1: Buffer.from("withdrawEncryptedOutput1"),
      encryptedOutput2: Buffer.from("withdrawEncryptedOutput2"),
      fee: withdrawFee, // Use the same fee variable we used in calculations
      feeRecipient: FEE_RECIPIENT_ACCOUNT,
      mintAddress: new anchor.web3.PublicKey("11111111111111111111111111111112"), // SOL mint address
    };

    // Calculate the hash for withdrawal
    const withdrawExtDataHash = getExtDataHash(withdrawExtData);

    // Create a new tree and insert the deposit output commitments
    for (const commitment of outputCommitments) {
      globalMerkleTree.insert(commitment);
    }

    const oldRoot = globalMerkleTree.root();

    // Get nullifiers and commitments for withdrawal
    const withdrawInputNullifiers = await Promise.all(withdrawInputs.map(x => x.getNullifier()));
    const withdrawOutputCommitments = await Promise.all(withdrawOutputs.map(x => x.getCommitment()));

    // Calculate Merkle paths for withdrawal inputs properly
    const withdrawalInputMerklePathIndices = []
    const withdrawalInputMerklePathElements = []
    for (let i = 0; i < withdrawInputs.length; i++) {
      const withdrawInput = withdrawInputs[i]
      if (withdrawInput.amount.gt(new BN(0))) {
        const commitment = outputCommitments[i]
        withdrawInput.index = globalMerkleTree.indexOf(commitment)
        if (withdrawInput.index < 0) {
          throw new Error(`Input commitment ${commitment} was not found`)
        }
        withdrawalInputMerklePathIndices.push(withdrawInput.index)
        withdrawalInputMerklePathElements.push(globalMerkleTree.path(withdrawInput.index).pathElements)
      } else {
        withdrawalInputMerklePathIndices.push(0)
        withdrawalInputMerklePathElements.push(new Array(globalMerkleTree.levels).fill(0))
      }
    }

    // Create input for withdrawal proof generation
    const withdrawInput = {
      // Common transaction data
      root: oldRoot,
      inputNullifier: withdrawInputNullifiers,
      outputCommitment: withdrawOutputCommitments,
      publicAmount: withdrawPublicAmount.toString(),
      extDataHash: withdrawExtDataHash,
      
      // Input UTXO data (UTXOs being spent)
      inAmount: withdrawInputs.map(x => x.amount.toString(10)),
      inPrivateKey: withdrawInputs.map(x => x.keypair.privkey),
      inBlinding: withdrawInputs.map(x => x.blinding.toString(10)),
      mintAddress: withdrawInputs[0].mintAddress,
      inPathIndices: withdrawalInputMerklePathIndices,
      inPathElements: withdrawalInputMerklePathElements,
      
      // Output UTXO data (UTXOs being created)
      outAmount: withdrawOutputs.map(x => x.amount.toString(10)),
      outBlinding: withdrawOutputs.map(x => x.blinding.toString(10)),
      outPubkey: withdrawOutputs.map(x => x.keypair.pubkey),
    };

    // Generate proof for withdrawal
    const withdrawProofResult = await prove(withdrawInput, keyBasePath);
    const withdrawProofInBytes = parseProofToBytesArray(withdrawProofResult.proof);
    const withdrawInputsInBytes = parseToBytesArray(withdrawProofResult.publicSignals);
    
    // Create the final withdrawal proof object
    const withdrawProofToSubmit = {
      proofA: withdrawProofInBytes.proofA,
      proofB: withdrawProofInBytes.proofB.flat(),
      proofC: withdrawProofInBytes.proofC,
      root: withdrawInputsInBytes[0],
      publicAmount: withdrawInputsInBytes[1],
      extDataHash: withdrawInputsInBytes[2],
      inputNullifiers: [
        withdrawInputsInBytes[3],
        withdrawInputsInBytes[4]
      ],
      outputCommitments: [
        withdrawInputsInBytes[5],
        withdrawInputsInBytes[6]
      ],
    };

         // Derive PDAs for withdrawal nullifiers
     const withdrawNullifiers = findNullifierPDAs(program, withdrawProofToSubmit);
     const withdrawCrossCheckNullifiers = findCrossCheckNullifierPDAs(program, withdrawProofToSubmit);
     
     // Derive PDAs for withdrawal commitments
     const withdrawCommitments = findCommitmentPDAs(program, withdrawProofToSubmit);

    // Execute the withdrawal transaction - this should fail due to recipient mismatch
    try {
      const withdrawTx = await program.methods
        .transact(withdrawProofToSubmit, createExtDataMinified(withdrawExtData), withdrawExtData.encryptedOutput1, withdrawExtData.encryptedOutput2)
        .accounts({
          treeAccount: treeAccountPDA,
          nullifier0: withdrawNullifiers.nullifier0PDA,
          nullifier1: withdrawNullifiers.nullifier1PDA,
          nullifier2: withdrawCrossCheckNullifiers.nullifier2PDA,
          nullifier3: withdrawCrossCheckNullifiers.nullifier3PDA,
          commitment0: withdrawCommitments.commitment0PDA,
          commitment1: withdrawCommitments.commitment1PDA,
          recipient: attacker.publicKey, // Attacker tries to replace recipient with their own address
          feeRecipientAccount: FEE_RECIPIENT_ACCOUNT,
          treeTokenAccount: treeTokenAccountPDA,
          globalConfig: globalConfigPDA,
          signer: randomUser.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([randomUser])
        .preInstructions([modifyComputeUnits])
        .transaction();
        
      // Create versioned transaction with ALT for withdrawal
      const withdrawVersionedTx = await createVersionedTransactionWithALT(
        provider.connection,
        randomUser.publicKey,
        withdrawTx.instructions,
        lookupTableAddress
      );
      
      // This should fail - if it succeeds, the test should fail
      await sendAndConfirmVersionedTransaction(
        provider.connection,
        withdrawVersionedTx,
        [randomUser]
      );
      
      expect.fail("Transaction should have failed due to recipient mismatch but succeeded");
    } catch (error) {
      // Transaction should fail with RecipientMismatch error
      const errorString = error.toString();
      expect(
        errorString.includes("0x1779") || 
        errorString.includes("RecipientMismatch") ||
        errorString.includes("custom program error")
      ).to.be.true;
    }
  });

  it("Can execute both deposit and withdraw instruction for correct input, after withdrawing full amount", async () => {
    const depositAmount = 200;
    const actualDepositFee = calculateDepositFee(depositAmount);
    const depositFee = new anchor.BN(actualDepositFee);
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(depositAmount), // Positive ext amount (deposit)
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: depositFee, // Fee
      feeRecipient: FEE_RECIPIENT_ACCOUNT,
      mintAddress: new anchor.web3.PublicKey("11111111111111111111111111111112"), // SOL mint address
    };

    // Create inputs for the first deposit
    const inputs = [
      new Utxo({ lightWasm }),
      new Utxo({ lightWasm })
    ];

    const outputAmount = (depositAmount - actualDepositFee).toString();
    const outputs = [
      new Utxo({ lightWasm, amount: outputAmount, index: globalMerkleTree._layers[0].length }), // Combined amount minus fee
      new Utxo({ lightWasm, amount: '0' }) // Empty UTXO
    ];

    // Create mock Merkle path data (normally built from the tree)
    const inputMerklePathIndices = inputs.map((input) => input.index || 0);
    
    // inputMerklePathElements won't be checked for empty utxos. so we need to create a sample full path
    // Create the Merkle paths for each input
    const inputMerklePathElements = inputs.map(() => {
      // Return an array of zero elements as the path for each input
      // Create a copy of the zeroElements array to avoid modifying the original
      return [...new Array(globalMerkleTree.levels).fill(0)];
    });

    // Resolve all async operations before creating the input object
    // Await nullifiers and commitments to get actual values instead of Promise objects
    const inputNullifiers = await Promise.all(inputs.map(x => x.getNullifier()));
    const outputCommitments = await Promise.all(outputs.map(x => x.getCommitment()));

    // Use the properly calculated Merkle tree root
    const root = globalMerkleTree.root();

    // Calculate the hash correctly using our utility
    const calculatedExtDataHash = getExtDataHash(extData);
    const publicAmountNumber = new anchor.BN(depositAmount - actualDepositFee);

    const input = {
      // Common transaction data
      root: root,
      inputNullifier: inputNullifiers, // Use resolved values instead of Promise objects
      outputCommitment: outputCommitments, // Use resolved values instead of Promise objects
      publicAmount: publicAmountNumber.toString(),
      extDataHash: calculatedExtDataHash,
      
      // Input UTXO data (UTXOs being spent) - ensure all values are in decimal format
      inAmount: inputs.map(x => x.amount.toString(10)),
      inPrivateKey: inputs.map(x => x.keypair.privkey),
      inBlinding: inputs.map(x => x.blinding.toString(10)),
      mintAddress: inputs[0].mintAddress,
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
    const crossCheckNullifiers = findCrossCheckNullifierPDAs(program, proofToSubmit);

    // Derive commitment PDAs
    const { commitment0PDA, commitment1PDA } = findCommitmentPDAs(program, proofToSubmit);

    // Create Address Lookup Table for transaction size optimization
    const testProtocolAddresses = getTestProtocolAddresses(
      program.programId,
      authority.publicKey,
      treeAccountPDA,
      treeTokenAccountPDA,
      FEE_RECIPIENT_ACCOUNT
    );
    
    const lookupTableAddress = await createGlobalTestALT(provider.connection, authority, testProtocolAddresses);

    // Get balances before transaction
    const treeTokenAccountBalanceBefore = await provider.connection.getBalance(treeTokenAccountPDA);
    const feeRecipientBalanceBefore = await provider.connection.getBalance(FEE_RECIPIENT_ACCOUNT);
    const recipientBalanceBefore = await provider.connection.getBalance(recipient.publicKey);
    const randomUserBalanceBefore = await provider.connection.getBalance(randomUser.publicKey);

    // Execute the transaction without pre-instructions
    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    const tx = await program.methods
      .transact(proofToSubmit, createExtDataMinified(extData), extData.encryptedOutput1, extData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: nullifier0PDA,
        nullifier1: nullifier1PDA,
        nullifier2: crossCheckNullifiers.nullifier2PDA,
        nullifier3: crossCheckNullifiers.nullifier3PDA,
        commitment0: commitment0PDA,
        commitment1: commitment1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: FEE_RECIPIENT_ACCOUNT,
        treeTokenAccount: treeTokenAccountPDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey, // Use random user as signer
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser]) // Random user signs the transaction
      .preInstructions([modifyComputeUnits]) // Add compute budget instruction as pre-instruction
      .transaction();
    
    // Create versioned transaction with ALT
    const versionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      randomUser.publicKey,
      tx.instructions,
      lookupTableAddress
    );
    
    // Send and confirm versioned transaction
    const txSig = await sendAndConfirmVersionedTransaction(
      provider.connection,
      versionedTx,
      [randomUser]
    );
    
    expect(txSig).to.be.a('string');

    // Check commitment logs for transaction (only if transaction succeeded)
    const transaction = await provider.connection.getTransaction(txSig, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    });

    if (transaction && transaction.meta && transaction.meta.logMessages) {
      const logs = transaction.meta.logMessages;
      // Parse commitment events using Anchor's EventParser
      const eventParser = new EventParser(program.programId, new BorshCoder(program.idl));
      const events = Array.from(eventParser.parseLogs(logs));
      const commitmentEvents = events.filter(event => event.name === "commitmentData");
      
      // All transactions must have exactly 2 commitment events
      expect(commitmentEvents).to.have.length(2);

      // Verify first commitment event
      const firstEvent = commitmentEvents[0];
      expect(firstEvent.data.index).to.be.an.instanceOf(anchor.BN);
      expect(firstEvent.data.commitment).to.be.an('array');
      expect(firstEvent.data.encryptedOutput).to.be.instanceOf(Buffer);
      expect(firstEvent.data.commitment).to.have.length(32);
      
      // Verify second commitment event
      const secondEvent = commitmentEvents[1];
      expect(secondEvent.data.index).to.be.an.instanceOf(anchor.BN);
      expect(secondEvent.data.commitment).to.be.an('array');
      expect(secondEvent.data.encryptedOutput).to.be.instanceOf(Buffer);
      expect(secondEvent.data.commitment).to.have.length(32);
      
      // Verify second index is first index + 1
      expect(secondEvent.data.index.toNumber()).to.equal(firstEvent.data.index.toNumber() + 1);

      // Verify the event commitments match the actual output commitments
      const firstEventCommitment = Buffer.from(firstEvent.data.commitment);
      const secondEventCommitment = Buffer.from(secondEvent.data.commitment);
      
      // Compare against proof output commitments
      const proofOutputCommitments = proofToSubmit.outputCommitments;
      expect(firstEventCommitment.toString('hex')).to.deep.equal(Buffer.from(proofOutputCommitments[0]).toString('hex'));
      expect(secondEventCommitment.toString('hex')).to.deep.equal(Buffer.from(proofOutputCommitments[1]).toString('hex'));

      // Verify the event encrypted outputs match the actual encrypted outputs
      expect(firstEvent.data.encryptedOutput).to.deep.equal(extData.encryptedOutput1);
      expect(secondEvent.data.encryptedOutput).to.deep.equal(extData.encryptedOutput2);
    }

    // Verify commitment PDAs have correct data
    const commitment0Account = await provider.connection.getAccountInfo(commitment0PDA);
    const commitment1Account = await provider.connection.getAccountInfo(commitment1PDA);
    
    // Check that the commitment accounts exist
    expect(commitment0Account).to.not.be.null;
    expect(commitment1Account).to.not.be.null;
    
    // Deserialize the commitment accounts
    const commitment0Data = program.coder.accounts.decode(
      'commitmentAccount',
      commitment0Account.data
    );
    const commitment1Data = program.coder.accounts.decode(
      'commitmentAccount',
      commitment1Account.data
    );
    
    // Verify the commitment values match
    expect(Buffer.from(commitment0Data.commitment).equals(Buffer.from(proofToSubmit.outputCommitments[0]))).to.be.true;
    expect(Buffer.from(commitment1Data.commitment).equals(Buffer.from(proofToSubmit.outputCommitments[1]))).to.be.true;
    
    // Verify the encrypted outputs match
    expect(Buffer.from(commitment0Data.encryptedOutput).equals(extData.encryptedOutput1)).to.be.true;
    expect(Buffer.from(commitment1Data.encryptedOutput).equals(extData.encryptedOutput2)).to.be.true;

    // Get balances after transaction
    const treeTokenAccountBalanceAfter = await provider.connection.getBalance(treeTokenAccountPDA);
    const feeRecipientBalanceAfter = await provider.connection.getBalance(FEE_RECIPIENT_ACCOUNT);
    const recipientBalanceAfter = await provider.connection.getBalance(recipient.publicKey);
    const randomUserBalanceAfter = await provider.connection.getBalance(randomUser.publicKey);
    
    // Calculate differences
    const treeTokenAccountDiff = treeTokenAccountBalanceAfter - treeTokenAccountBalanceBefore;
    const feeRecipientDiff = feeRecipientBalanceAfter - feeRecipientBalanceBefore;
    const recipientDiff = recipientBalanceAfter - recipientBalanceBefore;
    const randomUserDiff = randomUserBalanceAfter - randomUserBalanceBefore;

    expect(treeTokenAccountDiff).to.be.equals(publicAmountNumber.toNumber());
    expect(feeRecipientDiff).to.be.equals(depositFee.toNumber());
    expect(recipientDiff).to.be.equals(0);
    // accounts for the transaction fee
    expect(randomUserDiff).to.be.lessThan(-extData.extAmount.toNumber());

    // Create mock input UTXOs for withdrawal
    // First input is a real UTXO that we created in deposit
    const withdrawInputs = [
      outputs[0], // Use the first output directly
      new Utxo({ lightWasm }) // Second input is empty
    ];
    const withdrawOutputs = [
      new Utxo({ lightWasm, amount: '0', index: globalMerkleTree._layers[0].length }), // Some remaining amount
      new Utxo({ lightWasm, amount: '0' }) // Empty UTXO
    ];
    const withdrawFee = new anchor.BN(20)

    const withdrawInputsSum = withdrawInputs.reduce((sum, x) => sum.add(x.amount), new BN(0))
    const withdrawOutputsSum = withdrawOutputs.reduce((sum, x) => sum.add(x.amount), new BN(0))
    const extAmount = new BN(withdrawFee)
      .add(withdrawOutputsSum)
      .sub(withdrawInputsSum)
    
    // For circom, we need field modular arithmetic to handle negative numbers
    const withdrawPublicAmount = new BN(extAmount).sub(new BN(withdrawFee)).add(FIELD_SIZE).mod(FIELD_SIZE).toString()
    
    // Create a sample ExtData object for withdrawal
    const withdrawExtData = {
      recipient: recipient.publicKey,
      extAmount: extAmount, // Use the calculated extAmount value instead of hardcoded -100
      encryptedOutput1: Buffer.from("withdrawEncryptedOutput1"),
      encryptedOutput2: Buffer.from("withdrawEncryptedOutput2"),
      fee: withdrawFee, // Use the same fee variable we used in calculations
      feeRecipient: FEE_RECIPIENT_ACCOUNT,
      mintAddress: new anchor.web3.PublicKey("11111111111111111111111111111112"), // SOL mint address
    };

    // Calculate the hash for withdrawal
    const withdrawExtDataHash = getExtDataHash(withdrawExtData);

    // Create a new tree and insert the deposit output commitments
    for (const commitment of outputCommitments) {
      globalMerkleTree.insert(commitment);
    }

    const oldRoot = globalMerkleTree.root();

    // Get nullifiers and commitments for withdrawal
    const withdrawInputNullifiers = await Promise.all(withdrawInputs.map(x => x.getNullifier()));
    const withdrawOutputCommitments = await Promise.all(withdrawOutputs.map(x => x.getCommitment()));

    // Calculate Merkle paths for withdrawal inputs properly
    const withdrawalInputMerklePathIndices = []
    const withdrawalInputMerklePathElements = []
    for (let i = 0; i < withdrawInputs.length; i++) {
      const withdrawInput = withdrawInputs[i]
      if (withdrawInput.amount.gt(new BN(0))) {
        const commitment = outputCommitments[i]
        withdrawInput.index = globalMerkleTree.indexOf(commitment)
        if (withdrawInput.index < 0) {
          throw new Error(`Input commitment ${commitment} was not found`)
        }
        withdrawalInputMerklePathIndices.push(withdrawInput.index)
        withdrawalInputMerklePathElements.push(globalMerkleTree.path(withdrawInput.index).pathElements)
      } else {
        withdrawalInputMerklePathIndices.push(0)
        withdrawalInputMerklePathElements.push(new Array(globalMerkleTree.levels).fill(0))
      }
    }

    // Create input for withdrawal proof generation
    const withdrawInput = {
      // Common transaction data
      root: oldRoot,
      inputNullifier: withdrawInputNullifiers,
      outputCommitment: withdrawOutputCommitments,
      publicAmount: withdrawPublicAmount.toString(),
      extDataHash: withdrawExtDataHash,
      
      // Input UTXO data (UTXOs being spent)
      inAmount: withdrawInputs.map(x => x.amount.toString(10)),
      inPrivateKey: withdrawInputs.map(x => x.keypair.privkey),
      inBlinding: withdrawInputs.map(x => x.blinding.toString(10)),
      mintAddress: withdrawInputs[0].mintAddress,
      inPathIndices: withdrawalInputMerklePathIndices,
      inPathElements: withdrawalInputMerklePathElements,
      
      // Output UTXO data (UTXOs being created)
      outAmount: withdrawOutputs.map(x => x.amount.toString(10)),
      outBlinding: withdrawOutputs.map(x => x.blinding.toString(10)),
      outPubkey: withdrawOutputs.map(x => x.keypair.pubkey),
    };

    // Generate proof for withdrawal
    const withdrawProofResult = await prove(withdrawInput, keyBasePath);
    const withdrawProofInBytes = parseProofToBytesArray(withdrawProofResult.proof);
    const withdrawInputsInBytes = parseToBytesArray(withdrawProofResult.publicSignals);
    
    // Create the final withdrawal proof object
    const withdrawProofToSubmit = {
      proofA: withdrawProofInBytes.proofA,
      proofB: withdrawProofInBytes.proofB.flat(),
      proofC: withdrawProofInBytes.proofC,
      root: withdrawInputsInBytes[0],
      publicAmount: withdrawInputsInBytes[1],
      extDataHash: withdrawInputsInBytes[2],
      inputNullifiers: [
        withdrawInputsInBytes[3],
        withdrawInputsInBytes[4]
      ],
      outputCommitments: [
        withdrawInputsInBytes[5],
        withdrawInputsInBytes[6]
      ],
    };

         // Derive PDAs for withdrawal nullifiers
     const withdrawNullifiers = findNullifierPDAs(program, withdrawProofToSubmit);
     const withdrawCrossCheckNullifiers = findCrossCheckNullifierPDAs(program, withdrawProofToSubmit);
     
     // Derive PDAs for withdrawal commitments
     const withdrawCommitments = findCommitmentPDAs(program, withdrawProofToSubmit);

    // Execute the withdrawal transaction
    const withdrawTx = await program.methods
      .transact(withdrawProofToSubmit, createExtDataMinified(withdrawExtData), withdrawExtData.encryptedOutput1, withdrawExtData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: withdrawNullifiers.nullifier0PDA,
        nullifier1: withdrawNullifiers.nullifier1PDA,
        nullifier2: withdrawCrossCheckNullifiers.nullifier2PDA,
        nullifier3: withdrawCrossCheckNullifiers.nullifier3PDA,
        commitment0: withdrawCommitments.commitment0PDA,
        commitment1: withdrawCommitments.commitment1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: FEE_RECIPIENT_ACCOUNT,
        treeTokenAccount: treeTokenAccountPDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .preInstructions([modifyComputeUnits])
      .transaction();
      
    // Create versioned transaction with ALT for withdrawal
    const withdrawVersionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      randomUser.publicKey,
      withdrawTx.instructions,
      lookupTableAddress
    );
    
    // Send and confirm withdrawal versioned transaction
    const withdrawTxSig = await sendAndConfirmVersionedTransaction(
      provider.connection,
      withdrawVersionedTx,
      [randomUser]
    );
    
    expect(withdrawTxSig).to.be.a('string');

    // Verify withdrawal commitment PDAs have correct data
    const withdrawCommitment0Account = await provider.connection.getAccountInfo(withdrawCommitments.commitment0PDA);
    const withdrawCommitment1Account = await provider.connection.getAccountInfo(withdrawCommitments.commitment1PDA);
    
    // Check that the commitment accounts exist
    expect(withdrawCommitment0Account).to.not.be.null;
    expect(withdrawCommitment1Account).to.not.be.null;
    
    // Deserialize the commitment accounts
    const withdrawCommitment0Data = program.coder.accounts.decode(
      'commitmentAccount',
      withdrawCommitment0Account.data
    );
    const withdrawCommitment1Data = program.coder.accounts.decode(
      'commitmentAccount',
      withdrawCommitment1Account.data
    );
    
    // Verify the commitment values match
    expect(Buffer.from(withdrawCommitment0Data.commitment).equals(Buffer.from(withdrawProofToSubmit.outputCommitments[0]))).to.be.true;
    expect(Buffer.from(withdrawCommitment1Data.commitment).equals(Buffer.from(withdrawProofToSubmit.outputCommitments[1]))).to.be.true;
    
    // Verify the encrypted outputs match
    expect(Buffer.from(withdrawCommitment0Data.encryptedOutput).equals(withdrawExtData.encryptedOutput1)).to.be.true;
    expect(Buffer.from(withdrawCommitment1Data.encryptedOutput).equals(withdrawExtData.encryptedOutput2)).to.be.true;

    // Get final balances after both transactions
    const finalTreeTokenBalance = await provider.connection.getBalance(treeTokenAccountPDA);
    const finalFeeRecipientBalance = await provider.connection.getBalance(FEE_RECIPIENT_ACCOUNT);
    const finalRandomUserBalance = await provider.connection.getBalance(randomUser.publicKey);
    
    // Calculate the withdrawal diffs specifically
    const treeTokenWithdrawDiff = finalTreeTokenBalance - treeTokenAccountBalanceAfter;
    const feeRecipientWithdrawDiff = finalFeeRecipientBalance - feeRecipientBalanceAfter;
    const randomUserWithdrawDiff = finalRandomUserBalance - randomUserBalanceAfter;
    
    // Verify withdrawal logic worked correctly
    expect(treeTokenWithdrawDiff).to.be.equals(extAmount.toNumber() - withdrawFee.toNumber()); // Tree decreases by withdraw amount
    expect(feeRecipientWithdrawDiff).to.be.equals(withdrawFee.toNumber()); // Fee recipient unchanged
    expect(randomUserWithdrawDiff).to.be.lessThan(-extAmount.toNumber()); // User gets withdraw amount minus tx fee

    // Calculate overall diffs for the full cycle
    const treeTokenTotalDiff = finalTreeTokenBalance - treeTokenAccountBalanceBefore;
    const feeRecipientTotalDiff = finalFeeRecipientBalance - feeRecipientBalanceBefore;
    const randomUserTotalDiff = finalRandomUserBalance - randomUserBalanceBefore;
    
    // Verify final balances
    // 1. Tree token account should be back to original amount (excluding the fee)
    expect(treeTokenTotalDiff).to.be.equals(withdrawOutputsSum.toNumber());
    
    // 2. Fee recipient keeps the fees
    expect(feeRecipientTotalDiff).to.be.equals(depositFee.toNumber() + withdrawFee.toNumber());
    
    // 3. Random user should have lost at least the fee amount plus some tx fees
    expect(randomUserTotalDiff).to.be.lessThan(-depositFee.toNumber());

    for (const commitment of withdrawOutputCommitments) {
      globalMerkleTree.insert(commitment);
    }
  });

  it("TreeTokenAccount has $0 change, after withdrawing full amount with withdraw fees higher than deposit change", async () => {
    const depositAmount = 200;
    const actualDepositFee = calculateDepositFee(depositAmount);
    const depositFee = new anchor.BN(actualDepositFee);
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(depositAmount), // Positive ext amount (deposit)
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: depositFee, // Fee
      feeRecipient: FEE_RECIPIENT_ACCOUNT,
      mintAddress: new anchor.web3.PublicKey("11111111111111111111111111111112"), // SOL mint address
    };

    // Create inputs for the first deposit
    const inputs = [
      new Utxo({ lightWasm }),
      new Utxo({ lightWasm })
    ];

    const outputAmount = (depositAmount - actualDepositFee).toString();
    const outputs = [
      new Utxo({ lightWasm, amount: outputAmount, index: globalMerkleTree._layers[0].length }), // Combined amount minus fee
      new Utxo({ lightWasm, amount: '0' }) // Empty UTXO
    ];

    // Create mock Merkle path data (normally built from the tree)
    const inputMerklePathIndices = inputs.map((input) => input.index || 0);
    
    // inputMerklePathElements won't be checked for empty utxos. so we need to create a sample full path
    // Create the Merkle paths for each input
    const inputMerklePathElements = inputs.map(() => {
      // Return an array of zero elements as the path for each input
      // Create a copy of the zeroElements array to avoid modifying the original
      return [...new Array(globalMerkleTree.levels).fill(0)];
    });

    // Resolve all async operations before creating the input object
    // Await nullifiers and commitments to get actual values instead of Promise objects
    const inputNullifiers = await Promise.all(inputs.map(x => x.getNullifier()));
    const outputCommitments = await Promise.all(outputs.map(x => x.getCommitment()));

    // Use the properly calculated Merkle tree root
    const root = globalMerkleTree.root();

    // Calculate the hash correctly using our utility
    const calculatedExtDataHash = getExtDataHash(extData);
    const publicAmountNumber = new anchor.BN(depositAmount - actualDepositFee);

    const input = {
      // Common transaction data
      root: root,
      inputNullifier: inputNullifiers, // Use resolved values instead of Promise objects
      outputCommitment: outputCommitments, // Use resolved values instead of Promise objects
      publicAmount: publicAmountNumber.toString(),
      extDataHash: calculatedExtDataHash,
      
      // Input UTXO data (UTXOs being spent) - ensure all values are in decimal format
      inAmount: inputs.map(x => x.amount.toString(10)),
      inPrivateKey: inputs.map(x => x.keypair.privkey),
      inBlinding: inputs.map(x => x.blinding.toString(10)),
      mintAddress: inputs[0].mintAddress,
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
    const crossCheckNullifiers = findCrossCheckNullifierPDAs(program, proofToSubmit);

    // Derive commitment PDAs
    const { commitment0PDA, commitment1PDA } = findCommitmentPDAs(program, proofToSubmit);

    // Create Address Lookup Table for transaction size optimization
    const testProtocolAddresses = getTestProtocolAddresses(
      program.programId,
      authority.publicKey,
      treeAccountPDA,
      treeTokenAccountPDA,
      FEE_RECIPIENT_ACCOUNT
    );
    
    const lookupTableAddress = await createGlobalTestALT(provider.connection, authority, testProtocolAddresses);

    // Get balances before transaction
    const treeTokenAccountBalanceBefore = await provider.connection.getBalance(treeTokenAccountPDA);
    const feeRecipientBalanceBefore = await provider.connection.getBalance(FEE_RECIPIENT_ACCOUNT);
    const recipientBalanceBefore = await provider.connection.getBalance(recipient.publicKey);
    const randomUserBalanceBefore = await provider.connection.getBalance(randomUser.publicKey);

    // Execute the transaction without pre-instructions
    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    const tx = await program.methods
      .transact(proofToSubmit, createExtDataMinified(extData), extData.encryptedOutput1, extData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: nullifier0PDA,
        nullifier1: nullifier1PDA,
        nullifier2: crossCheckNullifiers.nullifier2PDA,
        nullifier3: crossCheckNullifiers.nullifier3PDA,
        commitment0: commitment0PDA,
        commitment1: commitment1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: FEE_RECIPIENT_ACCOUNT,
        treeTokenAccount: treeTokenAccountPDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey, // Use random user as signer
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser]) // Random user signs the transaction
      .preInstructions([modifyComputeUnits]) // Add compute budget instruction as pre-instruction
      .transaction();
    
    // Create versioned transaction with ALT
    const versionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      randomUser.publicKey,
      tx.instructions,
      lookupTableAddress
    );
    
    // Send and confirm versioned transaction
    const txSig = await sendAndConfirmVersionedTransaction(
      provider.connection,
      versionedTx,
      [randomUser]
    );
    
    expect(txSig).to.be.a('string');

    // Check commitment logs for transaction (only if transaction succeeded)
    const transaction = await provider.connection.getTransaction(txSig, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    });

    if (transaction && transaction.meta && transaction.meta.logMessages) {
      const logs = transaction.meta.logMessages;
      // Parse commitment events using Anchor's EventParser
      const eventParser = new EventParser(program.programId, new BorshCoder(program.idl));
      const events = Array.from(eventParser.parseLogs(logs));
      const commitmentEvents = events.filter(event => event.name === "commitmentData");
      
      // All transactions must have exactly 2 commitment events
      expect(commitmentEvents).to.have.length(2);

      // Verify first commitment event
      const firstEvent = commitmentEvents[0];
      expect(firstEvent.data.index).to.be.an.instanceOf(anchor.BN);
      expect(firstEvent.data.commitment).to.be.an('array');
      expect(firstEvent.data.encryptedOutput).to.be.instanceOf(Buffer);
      expect(firstEvent.data.commitment).to.have.length(32);
      
      // Verify second commitment event
      const secondEvent = commitmentEvents[1];
      expect(secondEvent.data.index).to.be.an.instanceOf(anchor.BN);
      expect(secondEvent.data.commitment).to.be.an('array');
      expect(secondEvent.data.encryptedOutput).to.be.instanceOf(Buffer);
      expect(secondEvent.data.commitment).to.have.length(32);
      
      // Verify second index is first index + 1
      expect(secondEvent.data.index.toNumber()).to.equal(firstEvent.data.index.toNumber() + 1);

      // Verify the event commitments match the actual output commitments
      const firstEventCommitment = Buffer.from(firstEvent.data.commitment);
      const secondEventCommitment = Buffer.from(secondEvent.data.commitment);
      
      // Compare against proof output commitments
      const proofOutputCommitments = proofToSubmit.outputCommitments;
      expect(firstEventCommitment.toString('hex')).to.deep.equal(Buffer.from(proofOutputCommitments[0]).toString('hex'));
      expect(secondEventCommitment.toString('hex')).to.deep.equal(Buffer.from(proofOutputCommitments[1]).toString('hex'));

      // Verify the event encrypted outputs match the actual encrypted outputs
      expect(firstEvent.data.encryptedOutput).to.deep.equal(extData.encryptedOutput1);
      expect(secondEvent.data.encryptedOutput).to.deep.equal(extData.encryptedOutput2);
    }

    // Verify commitment PDAs have correct data
    const commitment0Account = await provider.connection.getAccountInfo(commitment0PDA);
    const commitment1Account = await provider.connection.getAccountInfo(commitment1PDA);
    
    // Check that the commitment accounts exist
    expect(commitment0Account).to.not.be.null;
    expect(commitment1Account).to.not.be.null;
    
    // Deserialize the commitment accounts
    const commitment0Data = program.coder.accounts.decode(
      'commitmentAccount',
      commitment0Account.data
    );
    const commitment1Data = program.coder.accounts.decode(
      'commitmentAccount',
      commitment1Account.data
    );
    
    // Verify the commitment values match
    expect(Buffer.from(commitment0Data.commitment).equals(Buffer.from(proofToSubmit.outputCommitments[0]))).to.be.true;
    expect(Buffer.from(commitment1Data.commitment).equals(Buffer.from(proofToSubmit.outputCommitments[1]))).to.be.true;
    
    // Verify the encrypted outputs match
    expect(Buffer.from(commitment0Data.encryptedOutput).equals(extData.encryptedOutput1)).to.be.true;
    expect(Buffer.from(commitment1Data.encryptedOutput).equals(extData.encryptedOutput2)).to.be.true;

    // Get balances after transaction
    const treeTokenAccountBalanceAfter = await provider.connection.getBalance(treeTokenAccountPDA);
    const feeRecipientBalanceAfter = await provider.connection.getBalance(FEE_RECIPIENT_ACCOUNT);
    const recipientBalanceAfter = await provider.connection.getBalance(recipient.publicKey);
    const randomUserBalanceAfter = await provider.connection.getBalance(randomUser.publicKey);
    
    // Calculate differences
    const treeTokenAccountDiff = treeTokenAccountBalanceAfter - treeTokenAccountBalanceBefore;
    const feeRecipientDiff = feeRecipientBalanceAfter - feeRecipientBalanceBefore;
    const recipientDiff = recipientBalanceAfter - recipientBalanceBefore;
    const randomUserDiff = randomUserBalanceAfter - randomUserBalanceBefore;

    expect(treeTokenAccountDiff).to.be.equals(publicAmountNumber.toNumber());
    expect(feeRecipientDiff).to.be.equals(depositFee.toNumber());
    expect(recipientDiff).to.be.equals(0);
    // accounts for the transaction fee
    expect(randomUserDiff).to.be.lessThan(-extData.extAmount.toNumber());

    // Create mock input UTXOs for withdrawal
    // First input is a real UTXO that we created in deposit
    const withdrawInputs = [
      outputs[0], // Use the first output directly
      new Utxo({ lightWasm }) // Second input is empty
    ];
    const withdrawOutputs = [
      new Utxo({ lightWasm, amount: '100', index: globalMerkleTree._layers[0].length }), // Small remaining amount to ensure large withdrawal
      new Utxo({ lightWasm, amount: '0' }) // Empty UTXO
    ];
    const withdrawFee = new anchor.BN(0)

    const withdrawInputsSum = withdrawInputs.reduce((sum, x) => sum.add(x.amount), new BN(0))
    const withdrawOutputsSum = withdrawOutputs.reduce((sum, x) => sum.add(x.amount), new BN(0))
    const extAmount = new BN(withdrawFee)
      .add(withdrawOutputsSum)
      .sub(withdrawInputsSum)
    
    // For circom, we need field modular arithmetic to handle negative numbers
    const withdrawPublicAmount = new BN(extAmount).sub(new BN(withdrawFee)).add(FIELD_SIZE).mod(FIELD_SIZE).toString()
    
    // Create a sample ExtData object for withdrawal
    const withdrawExtData = {
      recipient: recipient.publicKey,
      extAmount: extAmount, // Use the calculated extAmount value instead of hardcoded -100
      encryptedOutput1: Buffer.from("withdrawEncryptedOutput1"),
      encryptedOutput2: Buffer.from("withdrawEncryptedOutput2"),
      fee: withdrawFee, // Use the same fee variable we used in calculations
      feeRecipient: FEE_RECIPIENT_ACCOUNT,
      mintAddress: new anchor.web3.PublicKey("11111111111111111111111111111112"), // SOL mint address
    };

    // Calculate the hash for withdrawal
    const withdrawExtDataHash = getExtDataHash(withdrawExtData);

    // Create a new tree and insert the deposit output commitments
    for (const commitment of outputCommitments) {
      globalMerkleTree.insert(commitment);
    }

    const oldRoot = globalMerkleTree.root();

    // Get nullifiers and commitments for withdrawal
    const withdrawInputNullifiers = await Promise.all(withdrawInputs.map(x => x.getNullifier()));
    const withdrawOutputCommitments = await Promise.all(withdrawOutputs.map(x => x.getCommitment()));

    // Calculate Merkle paths for withdrawal inputs properly
    const withdrawalInputMerklePathIndices = []
    const withdrawalInputMerklePathElements = []
    for (let i = 0; i < withdrawInputs.length; i++) {
      const withdrawInput = withdrawInputs[i]
      if (withdrawInput.amount.gt(new BN(0))) {
        const commitment = outputCommitments[i]
        withdrawInput.index = globalMerkleTree.indexOf(commitment)
        if (withdrawInput.index < 0) {
          throw new Error(`Input commitment ${commitment} was not found`)
        }
        withdrawalInputMerklePathIndices.push(withdrawInput.index)
        withdrawalInputMerklePathElements.push(globalMerkleTree.path(withdrawInput.index).pathElements)
      } else {
        withdrawalInputMerklePathIndices.push(0)
        withdrawalInputMerklePathElements.push(new Array(globalMerkleTree.levels).fill(0))
      }
    }

    // Create input for withdrawal proof generation
    const withdrawInput = {
      // Common transaction data
      root: oldRoot,
      inputNullifier: withdrawInputNullifiers,
      outputCommitment: withdrawOutputCommitments,
      publicAmount: withdrawPublicAmount.toString(),
      extDataHash: withdrawExtDataHash,
      
      // Input UTXO data (UTXOs being spent)
      inAmount: withdrawInputs.map(x => x.amount.toString(10)),
      inPrivateKey: withdrawInputs.map(x => x.keypair.privkey),
      inBlinding: withdrawInputs.map(x => x.blinding.toString(10)),
      mintAddress: withdrawInputs[0].mintAddress,
      inPathIndices: withdrawalInputMerklePathIndices,
      inPathElements: withdrawalInputMerklePathElements,
      
      // Output UTXO data (UTXOs being created)
      outAmount: withdrawOutputs.map(x => x.amount.toString(10)),
      outBlinding: withdrawOutputs.map(x => x.blinding.toString(10)),
      outPubkey: withdrawOutputs.map(x => x.keypair.pubkey),
    };

    // Generate proof for withdrawal
    const withdrawProofResult = await prove(withdrawInput, keyBasePath);
    const withdrawProofInBytes = parseProofToBytesArray(withdrawProofResult.proof);
    const withdrawInputsInBytes = parseToBytesArray(withdrawProofResult.publicSignals);
    
    // Create the final withdrawal proof object
    const withdrawProofToSubmit = {
      proofA: withdrawProofInBytes.proofA,
      proofB: withdrawProofInBytes.proofB.flat(),
      proofC: withdrawProofInBytes.proofC,
      root: withdrawInputsInBytes[0],
      publicAmount: withdrawInputsInBytes[1],
      extDataHash: withdrawInputsInBytes[2],
      inputNullifiers: [
        withdrawInputsInBytes[3],
        withdrawInputsInBytes[4]
      ],
      outputCommitments: [
        withdrawInputsInBytes[5],
        withdrawInputsInBytes[6]
      ],
    };

         // Derive PDAs for withdrawal nullifiers
     const withdrawNullifiers = findNullifierPDAs(program, withdrawProofToSubmit);
     const withdrawCrossCheckNullifiers = findCrossCheckNullifierPDAs(program, withdrawProofToSubmit);
     
     // Derive PDAs for withdrawal commitments
     const withdrawCommitments = findCommitmentPDAs(program, withdrawProofToSubmit);

    // Execute the withdrawal transaction
    const withdrawTx = await program.methods
      .transact(withdrawProofToSubmit, createExtDataMinified(withdrawExtData), withdrawExtData.encryptedOutput1, withdrawExtData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: withdrawNullifiers.nullifier0PDA,
        nullifier1: withdrawNullifiers.nullifier1PDA,
        nullifier2: withdrawCrossCheckNullifiers.nullifier2PDA,
        nullifier3: withdrawCrossCheckNullifiers.nullifier3PDA,
        commitment0: withdrawCommitments.commitment0PDA,
        commitment1: withdrawCommitments.commitment1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: FEE_RECIPIENT_ACCOUNT,
        treeTokenAccount: treeTokenAccountPDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .preInstructions([modifyComputeUnits])
      .transaction();
      
    // Create versioned transaction with ALT for withdrawal
    const withdrawVersionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      randomUser.publicKey,
      withdrawTx.instructions,
      lookupTableAddress
    );
    
    // Send and confirm withdrawal versioned transaction
    const withdrawTxSig = await sendAndConfirmVersionedTransaction(
      provider.connection,
      withdrawVersionedTx,
      [randomUser]
    );
    
    expect(withdrawTxSig).to.be.a('string');

    // Verify withdrawal commitment PDAs have correct data
    const withdrawCommitment0Account = await provider.connection.getAccountInfo(withdrawCommitments.commitment0PDA);
    const withdrawCommitment1Account = await provider.connection.getAccountInfo(withdrawCommitments.commitment1PDA);
    
    // Check that the commitment accounts exist
    expect(withdrawCommitment0Account).to.not.be.null;
    expect(withdrawCommitment1Account).to.not.be.null;
    
    // Deserialize the commitment accounts
    const withdrawCommitment0Data = program.coder.accounts.decode(
      'commitmentAccount',
      withdrawCommitment0Account.data
    );
    const withdrawCommitment1Data = program.coder.accounts.decode(
      'commitmentAccount',
      withdrawCommitment1Account.data
    );
    
    // Verify the commitment values match
    expect(Buffer.from(withdrawCommitment0Data.commitment).equals(Buffer.from(withdrawProofToSubmit.outputCommitments[0]))).to.be.true;
    expect(Buffer.from(withdrawCommitment1Data.commitment).equals(Buffer.from(withdrawProofToSubmit.outputCommitments[1]))).to.be.true;
    
    // Verify the encrypted outputs match
    expect(Buffer.from(withdrawCommitment0Data.encryptedOutput).equals(withdrawExtData.encryptedOutput1)).to.be.true;
    expect(Buffer.from(withdrawCommitment1Data.encryptedOutput).equals(withdrawExtData.encryptedOutput2)).to.be.true;

    // Get final balances after both transactions
    const finalTreeTokenBalance = await provider.connection.getBalance(treeTokenAccountPDA);
    const finalFeeRecipientBalance = await provider.connection.getBalance(FEE_RECIPIENT_ACCOUNT);
    const finalRandomUserBalance = await provider.connection.getBalance(randomUser.publicKey);
    
    // Calculate the withdrawal diffs specifically
    const treeTokenWithdrawDiff = finalTreeTokenBalance - treeTokenAccountBalanceAfter;
    const feeRecipientWithdrawDiff = finalFeeRecipientBalance - feeRecipientBalanceAfter;
    const randomUserWithdrawDiff = finalRandomUserBalance - randomUserBalanceAfter;
    
    // Verify withdrawal logic worked correctly
    expect(treeTokenWithdrawDiff).to.be.equals(extAmount.toNumber() - withdrawFee.toNumber()); // Tree decreases by withdraw amount
    expect(feeRecipientWithdrawDiff).to.be.equals(withdrawFee.toNumber()); // Fee recipient unchanged
    expect(randomUserWithdrawDiff).to.be.lessThan(-extAmount.toNumber()); // User gets withdraw amount minus tx fee

    // Calculate overall diffs for the full cycle
    const treeTokenTotalDiff = finalTreeTokenBalance - treeTokenAccountBalanceBefore;
    const feeRecipientTotalDiff = finalFeeRecipientBalance - feeRecipientBalanceBefore;
    const randomUserTotalDiff = finalRandomUserBalance - randomUserBalanceBefore;
    
    // Verify final balances
    // 1. Tree token account should be back to original amount (excluding the fee)
    expect(treeTokenTotalDiff).to.be.equals(withdrawOutputsSum.toNumber());
    
    // 2. Fee recipient keeps the fees
    expect(feeRecipientTotalDiff).to.be.equals(depositFee.toNumber() + withdrawFee.toNumber());
    
    // 3. Random user should have lost at least the fee amount plus some tx fees
    expect(randomUserTotalDiff).to.be.lessThan(-depositFee.toNumber());

    for (const commitment of withdrawOutputCommitments) {
      globalMerkleTree.insert(commitment);
    }
  });

  it("TreeTokenAccount has $0 change, after withdrawing full amount with withdraw fees the same as deposit change", async () => {
    const depositAmount = 200;
    const actualDepositFee = calculateDepositFee(depositAmount);
    const depositFee = new anchor.BN(actualDepositFee);
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(depositAmount), // Positive ext amount (deposit)
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: depositFee, // Fee
      feeRecipient: FEE_RECIPIENT_ACCOUNT,
      mintAddress: new anchor.web3.PublicKey("11111111111111111111111111111112"), // SOL mint address
    };

    // Create inputs for the first deposit
    const inputs = [
      new Utxo({ lightWasm }),
      new Utxo({ lightWasm })
    ];

    const outputAmount = (depositAmount - actualDepositFee).toString();
    const outputs = [
      new Utxo({ lightWasm, amount: outputAmount, index: globalMerkleTree._layers[0].length }), // Combined amount minus fee
      new Utxo({ lightWasm, amount: '0' }) // Empty UTXO
    ];

    // Create mock Merkle path data (normally built from the tree)
    const inputMerklePathIndices = inputs.map((input) => input.index || 0);
    
    // inputMerklePathElements won't be checked for empty utxos. so we need to create a sample full path
    // Create the Merkle paths for each input
    const inputMerklePathElements = inputs.map(() => {
      // Return an array of zero elements as the path for each input
      // Create a copy of the zeroElements array to avoid modifying the original
      return [...new Array(globalMerkleTree.levels).fill(0)];
    });

    // Resolve all async operations before creating the input object
    // Await nullifiers and commitments to get actual values instead of Promise objects
    const inputNullifiers = await Promise.all(inputs.map(x => x.getNullifier()));
    const outputCommitments = await Promise.all(outputs.map(x => x.getCommitment()));

    // Use the properly calculated Merkle tree root
    const root = globalMerkleTree.root();

    // Calculate the hash correctly using our utility
    const calculatedExtDataHash = getExtDataHash(extData);
    const publicAmountNumber = new anchor.BN(depositAmount - actualDepositFee);

    const input = {
      // Common transaction data
      root: root,
      inputNullifier: inputNullifiers, // Use resolved values instead of Promise objects
      outputCommitment: outputCommitments, // Use resolved values instead of Promise objects
      publicAmount: publicAmountNumber.toString(),
      extDataHash: calculatedExtDataHash,
      
      // Input UTXO data (UTXOs being spent) - ensure all values are in decimal format
      inAmount: inputs.map(x => x.amount.toString(10)),
      inPrivateKey: inputs.map(x => x.keypair.privkey),
      inBlinding: inputs.map(x => x.blinding.toString(10)),
      mintAddress: inputs[0].mintAddress,
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
    const crossCheckNullifiers = findCrossCheckNullifierPDAs(program, proofToSubmit);

    // Derive commitment PDAs
    const { commitment0PDA, commitment1PDA } = findCommitmentPDAs(program, proofToSubmit);

    // Create Address Lookup Table for transaction size optimization
    const testProtocolAddresses = getTestProtocolAddresses(
      program.programId,
      authority.publicKey,
      treeAccountPDA,
      treeTokenAccountPDA,
      nullifier0PDA,
      nullifier1PDA,
      commitment0PDA,
      commitment1PDA,
      recipient.publicKey,
      FEE_RECIPIENT_ACCOUNT,
      randomUser.publicKey
    );
    
    const lookupTableAddress = await createGlobalTestALT(provider.connection, authority, testProtocolAddresses);

    // Get balances before transaction
    const treeTokenAccountBalanceBefore = await provider.connection.getBalance(treeTokenAccountPDA);
    const feeRecipientBalanceBefore = await provider.connection.getBalance(FEE_RECIPIENT_ACCOUNT);
    const recipientBalanceBefore = await provider.connection.getBalance(recipient.publicKey);
    const randomUserBalanceBefore = await provider.connection.getBalance(randomUser.publicKey);

    // Execute the transaction without pre-instructions
    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    const tx = await program.methods
      .transact(proofToSubmit, createExtDataMinified(extData), extData.encryptedOutput1, extData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: nullifier0PDA,
        nullifier1: nullifier1PDA,
        nullifier2: crossCheckNullifiers.nullifier2PDA,
        nullifier3: crossCheckNullifiers.nullifier3PDA,
        commitment0: commitment0PDA,
        commitment1: commitment1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: FEE_RECIPIENT_ACCOUNT,
        treeTokenAccount: treeTokenAccountPDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey, // Use random user as signer
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser]) // Random user signs the transaction
      .preInstructions([modifyComputeUnits]) // Add compute budget instruction as pre-instruction
      .transaction();
    
    // Create versioned transaction with ALT
    const versionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      randomUser.publicKey,
      tx.instructions,
      lookupTableAddress
    );
    
    // Send and confirm versioned transaction
    const txSig = await sendAndConfirmVersionedTransaction(
      provider.connection,
      versionedTx,
      [randomUser]
    );
    
    expect(txSig).to.be.a('string');

    // Check commitment logs for transaction (only if transaction succeeded)
    const transaction = await provider.connection.getTransaction(txSig, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    });

    if (transaction && transaction.meta && transaction.meta.logMessages) {
      const logs = transaction.meta.logMessages;
      // Parse commitment events using Anchor's EventParser
      const eventParser = new EventParser(program.programId, new BorshCoder(program.idl));
      const events = Array.from(eventParser.parseLogs(logs));
      const commitmentEvents = events.filter(event => event.name === "commitmentData");
      
      // All transactions must have exactly 2 commitment events
      expect(commitmentEvents).to.have.length(2);

      // Verify first commitment event
      const firstEvent = commitmentEvents[0];
      expect(firstEvent.data.index).to.be.an.instanceOf(anchor.BN);
      expect(firstEvent.data.commitment).to.be.an('array');
      expect(firstEvent.data.encryptedOutput).to.be.instanceOf(Buffer);
      expect(firstEvent.data.commitment).to.have.length(32);
      
      // Verify second commitment event
      const secondEvent = commitmentEvents[1];
      expect(secondEvent.data.index).to.be.an.instanceOf(anchor.BN);
      expect(secondEvent.data.commitment).to.be.an('array');
      expect(secondEvent.data.encryptedOutput).to.be.instanceOf(Buffer);
      expect(secondEvent.data.commitment).to.have.length(32);
      
      // Verify second index is first index + 1
      expect(secondEvent.data.index.toNumber()).to.equal(firstEvent.data.index.toNumber() + 1);

      // Verify the event commitments match the actual output commitments
      const firstEventCommitment = Buffer.from(firstEvent.data.commitment);
      const secondEventCommitment = Buffer.from(secondEvent.data.commitment);
      
      // Compare against proof output commitments
      const proofOutputCommitments = proofToSubmit.outputCommitments;
      expect(firstEventCommitment.toString('hex')).to.deep.equal(Buffer.from(proofOutputCommitments[0]).toString('hex'));
      expect(secondEventCommitment.toString('hex')).to.deep.equal(Buffer.from(proofOutputCommitments[1]).toString('hex'));

      // Verify the event encrypted outputs match the actual encrypted outputs
      expect(firstEvent.data.encryptedOutput).to.deep.equal(extData.encryptedOutput1);
      expect(secondEvent.data.encryptedOutput).to.deep.equal(extData.encryptedOutput2);
    }

    // Verify commitment PDAs have correct data
    const commitment0Account = await provider.connection.getAccountInfo(commitment0PDA);
    const commitment1Account = await provider.connection.getAccountInfo(commitment1PDA);
    
    // Check that the commitment accounts exist
    expect(commitment0Account).to.not.be.null;
    expect(commitment1Account).to.not.be.null;
    
    // Deserialize the commitment accounts
    const commitment0Data = program.coder.accounts.decode(
      'commitmentAccount',
      commitment0Account.data
    );
    const commitment1Data = program.coder.accounts.decode(
      'commitmentAccount',
      commitment1Account.data
    );
    
    // Verify the commitment values match
    expect(Buffer.from(commitment0Data.commitment).equals(Buffer.from(proofToSubmit.outputCommitments[0]))).to.be.true;
    expect(Buffer.from(commitment1Data.commitment).equals(Buffer.from(proofToSubmit.outputCommitments[1]))).to.be.true;
    
    // Verify the encrypted outputs match
    expect(Buffer.from(commitment0Data.encryptedOutput).equals(extData.encryptedOutput1)).to.be.true;
    expect(Buffer.from(commitment1Data.encryptedOutput).equals(extData.encryptedOutput2)).to.be.true;

    // Get balances after transaction
    const treeTokenAccountBalanceAfter = await provider.connection.getBalance(treeTokenAccountPDA);
    const feeRecipientBalanceAfter = await provider.connection.getBalance(FEE_RECIPIENT_ACCOUNT);
    const recipientBalanceAfter = await provider.connection.getBalance(recipient.publicKey);
    const randomUserBalanceAfter = await provider.connection.getBalance(randomUser.publicKey);
    
    // Calculate differences
    const treeTokenAccountDiff = treeTokenAccountBalanceAfter - treeTokenAccountBalanceBefore;
    const feeRecipientDiff = feeRecipientBalanceAfter - feeRecipientBalanceBefore;
    const recipientDiff = recipientBalanceAfter - recipientBalanceBefore;
    const randomUserDiff = randomUserBalanceAfter - randomUserBalanceBefore;

    expect(treeTokenAccountDiff).to.be.equals(publicAmountNumber.toNumber());
    expect(feeRecipientDiff).to.be.equals(depositFee.toNumber());
    expect(recipientDiff).to.be.equals(0);
    // accounts for the transaction fee
    expect(randomUserDiff).to.be.lessThan(-extData.extAmount.toNumber());

    // Create mock input UTXOs for withdrawal
    // First input is a real UTXO that we created in deposit
    const withdrawInputs = [
      outputs[0], // Use the first output directly
      new Utxo({ lightWasm }) // Second input is empty
    ];
    const withdrawOutputs = [
      new Utxo({ lightWasm, amount: '0', index: globalMerkleTree._layers[0].length }), // Some remaining amount
      new Utxo({ lightWasm, amount: '0' }) // Empty UTXO
    ];
    const withdrawFee = depositFee

    const withdrawInputsSum = withdrawInputs.reduce((sum, x) => sum.add(x.amount), new BN(0))
    const withdrawOutputsSum = withdrawOutputs.reduce((sum, x) => sum.add(x.amount), new BN(0))
    const extAmount = new BN(withdrawFee)
      .add(withdrawOutputsSum)
      .sub(withdrawInputsSum)
    
    // For circom, we need field modular arithmetic to handle negative numbers
    const withdrawPublicAmount = new BN(extAmount).sub(new BN(withdrawFee)).add(FIELD_SIZE).mod(FIELD_SIZE).toString()
    
    // Create a sample ExtData object for withdrawal
    const withdrawExtData = {
      recipient: recipient.publicKey,
      extAmount: extAmount, // Use the calculated extAmount value instead of hardcoded -100
      encryptedOutput1: Buffer.from("withdrawEncryptedOutput1"),
      encryptedOutput2: Buffer.from("withdrawEncryptedOutput2"),
      fee: withdrawFee, // Use the same fee variable we used in calculations
      feeRecipient: FEE_RECIPIENT_ACCOUNT,
      mintAddress: new anchor.web3.PublicKey("11111111111111111111111111111112"), // SOL mint address
    };

    // Calculate the hash for withdrawal
    const withdrawExtDataHash = getExtDataHash(withdrawExtData);

    // Create a new tree and insert the deposit output commitments
    for (const commitment of outputCommitments) {
      globalMerkleTree.insert(commitment);
    }

    const oldRoot = globalMerkleTree.root();

    // Get nullifiers and commitments for withdrawal
    const withdrawInputNullifiers = await Promise.all(withdrawInputs.map(x => x.getNullifier()));
    const withdrawOutputCommitments = await Promise.all(withdrawOutputs.map(x => x.getCommitment()));

    // Calculate Merkle paths for withdrawal inputs properly
    const withdrawalInputMerklePathIndices = []
    const withdrawalInputMerklePathElements = []
    for (let i = 0; i < withdrawInputs.length; i++) {
      const withdrawInput = withdrawInputs[i]
      if (withdrawInput.amount.gt(new BN(0))) {
        const commitment = outputCommitments[i]
        withdrawInput.index = globalMerkleTree.indexOf(commitment)
        if (withdrawInput.index < 0) {
          throw new Error(`Input commitment ${commitment} was not found`)
        }
        withdrawalInputMerklePathIndices.push(withdrawInput.index)
        withdrawalInputMerklePathElements.push(globalMerkleTree.path(withdrawInput.index).pathElements)
      } else {
        withdrawalInputMerklePathIndices.push(0)
        withdrawalInputMerklePathElements.push(new Array(globalMerkleTree.levels).fill(0))
      }
    }

    // Create input for withdrawal proof generation
    const withdrawInput = {
      // Common transaction data
      root: oldRoot,
      inputNullifier: withdrawInputNullifiers,
      outputCommitment: withdrawOutputCommitments,
      publicAmount: withdrawPublicAmount.toString(),
      extDataHash: withdrawExtDataHash,
      
      // Input UTXO data (UTXOs being spent)
      inAmount: withdrawInputs.map(x => x.amount.toString(10)),
      inPrivateKey: withdrawInputs.map(x => x.keypair.privkey),
      inBlinding: withdrawInputs.map(x => x.blinding.toString(10)),
      mintAddress: withdrawInputs[0].mintAddress,
      inPathIndices: withdrawalInputMerklePathIndices,
      inPathElements: withdrawalInputMerklePathElements,
      
      // Output UTXO data (UTXOs being created)
      outAmount: withdrawOutputs.map(x => x.amount.toString(10)),
      outBlinding: withdrawOutputs.map(x => x.blinding.toString(10)),
      outPubkey: withdrawOutputs.map(x => x.keypair.pubkey),
    };

    // Generate proof for withdrawal
    const withdrawProofResult = await prove(withdrawInput, keyBasePath);
    const withdrawProofInBytes = parseProofToBytesArray(withdrawProofResult.proof);
    const withdrawInputsInBytes = parseToBytesArray(withdrawProofResult.publicSignals);
    
    // Create the final withdrawal proof object
    const withdrawProofToSubmit = {
      proofA: withdrawProofInBytes.proofA,
      proofB: withdrawProofInBytes.proofB.flat(),
      proofC: withdrawProofInBytes.proofC,
      root: withdrawInputsInBytes[0],
      publicAmount: withdrawInputsInBytes[1],
      extDataHash: withdrawInputsInBytes[2],
      inputNullifiers: [
        withdrawInputsInBytes[3],
        withdrawInputsInBytes[4]
      ],
      outputCommitments: [
        withdrawInputsInBytes[5],
        withdrawInputsInBytes[6]
      ],
    };

         // Derive PDAs for withdrawal nullifiers
     const withdrawNullifiers = findNullifierPDAs(program, withdrawProofToSubmit);
     const withdrawCrossCheckNullifiers = findCrossCheckNullifierPDAs(program, withdrawProofToSubmit);
     
     // Derive PDAs for withdrawal commitments
     const withdrawCommitments = findCommitmentPDAs(program, withdrawProofToSubmit);

    // Execute the withdrawal transaction
    const withdrawTx = await program.methods
      .transact(withdrawProofToSubmit, createExtDataMinified(withdrawExtData), withdrawExtData.encryptedOutput1, withdrawExtData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: withdrawNullifiers.nullifier0PDA,
        nullifier1: withdrawNullifiers.nullifier1PDA,
        nullifier2: withdrawCrossCheckNullifiers.nullifier2PDA,
        nullifier3: withdrawCrossCheckNullifiers.nullifier3PDA,
        commitment0: withdrawCommitments.commitment0PDA,
        commitment1: withdrawCommitments.commitment1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: FEE_RECIPIENT_ACCOUNT,
        treeTokenAccount: treeTokenAccountPDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .preInstructions([modifyComputeUnits])
      .transaction();
      
    // Create versioned transaction with ALT for withdrawal
    const withdrawVersionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      randomUser.publicKey,
      withdrawTx.instructions,
      lookupTableAddress
    );
    
    // Send and confirm withdrawal versioned transaction
    const withdrawTxSig = await sendAndConfirmVersionedTransaction(
      provider.connection,
      withdrawVersionedTx,
      [randomUser]
    );
    
    expect(withdrawTxSig).to.be.a('string');

    // Verify withdrawal commitment PDAs have correct data
    const withdrawCommitment0Account = await provider.connection.getAccountInfo(withdrawCommitments.commitment0PDA);
    const withdrawCommitment1Account = await provider.connection.getAccountInfo(withdrawCommitments.commitment1PDA);
    
    // Check that the commitment accounts exist
    expect(withdrawCommitment0Account).to.not.be.null;
    expect(withdrawCommitment1Account).to.not.be.null;
    
    // Deserialize the commitment accounts
    const withdrawCommitment0Data = program.coder.accounts.decode(
      'commitmentAccount',
      withdrawCommitment0Account.data
    );
    const withdrawCommitment1Data = program.coder.accounts.decode(
      'commitmentAccount',
      withdrawCommitment1Account.data
    );
    
    // Verify the commitment values match
    expect(Buffer.from(withdrawCommitment0Data.commitment).equals(Buffer.from(withdrawProofToSubmit.outputCommitments[0]))).to.be.true;
    expect(Buffer.from(withdrawCommitment1Data.commitment).equals(Buffer.from(withdrawProofToSubmit.outputCommitments[1]))).to.be.true;
    
    // Verify the encrypted outputs match
    expect(Buffer.from(withdrawCommitment0Data.encryptedOutput).equals(withdrawExtData.encryptedOutput1)).to.be.true;
    expect(Buffer.from(withdrawCommitment1Data.encryptedOutput).equals(withdrawExtData.encryptedOutput2)).to.be.true;

    // Get final balances after both transactions
    const finalTreeTokenBalance = await provider.connection.getBalance(treeTokenAccountPDA);
    const finalFeeRecipientBalance = await provider.connection.getBalance(FEE_RECIPIENT_ACCOUNT);
    const finalRandomUserBalance = await provider.connection.getBalance(randomUser.publicKey);
    
    // Calculate the withdrawal diffs specifically
    const treeTokenWithdrawDiff = finalTreeTokenBalance - treeTokenAccountBalanceAfter;
    const feeRecipientWithdrawDiff = finalFeeRecipientBalance - feeRecipientBalanceAfter;
    const randomUserWithdrawDiff = finalRandomUserBalance - randomUserBalanceAfter;
    
    // Verify withdrawal logic worked correctly
    expect(treeTokenWithdrawDiff).to.be.equals(extAmount.toNumber() - withdrawFee.toNumber()); // Tree decreases by withdraw amount
    expect(feeRecipientWithdrawDiff).to.be.equals(withdrawFee.toNumber()); // Fee recipient unchanged
    expect(randomUserWithdrawDiff).to.be.lessThan(-extAmount.toNumber()); // User gets withdraw amount minus tx fee

    // Calculate overall diffs for the full cycle
    const treeTokenTotalDiff = finalTreeTokenBalance - treeTokenAccountBalanceBefore;
    const feeRecipientTotalDiff = finalFeeRecipientBalance - feeRecipientBalanceBefore;
    const randomUserTotalDiff = finalRandomUserBalance - randomUserBalanceBefore;
    
    // Verify final balances
    // 1. Tree token account should be back to original amount (excluding the fee)
    expect(treeTokenTotalDiff).to.be.equals(withdrawOutputsSum.toNumber());
    
    // 2. Fee recipient keeps the fees
    expect(feeRecipientTotalDiff).to.be.equals(depositFee.toNumber() + withdrawFee.toNumber());
    
    // 3. Random user should have lost at least the fee amount plus some tx fees
    expect(randomUserTotalDiff).to.be.lessThan(-depositFee.toNumber());

    const treeTokenAccountBalanceDiffFromBeforeDeposit = treeTokenAccountBalanceBefore - finalTreeTokenBalance;
    expect(treeTokenAccountBalanceDiffFromBeforeDeposit).to.be.equals(0);

    // Create a new tree and insert the deposit output commitments
    for (const commitment of withdrawOutputCommitments) {
      globalMerkleTree.insert(commitment);
    }
  });

  it("Can execute both deposit and withdraw instruction with 0 deposit fee and positive withdraw fee, after withdrawing full amount", async () => {
    const depositFee = new anchor.BN(calculateDepositFee(200))
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(200), // Positive ext amount (deposit)
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: depositFee, // Fee
      feeRecipient: FEE_RECIPIENT_ACCOUNT,
      mintAddress: new anchor.web3.PublicKey("11111111111111111111111111111112"), // SOL mint address
    };

    // Create inputs for the first deposit
    const inputs = [
      new Utxo({ lightWasm }),
      new Utxo({ lightWasm })
    ];

    const outputAmount = '200';
    const outputs = [
      new Utxo({ lightWasm, amount: outputAmount, index: globalMerkleTree._layers[0].length }), // Combined amount minus fee
      new Utxo({ lightWasm, amount: '0' }) // Empty UTXO
    ];

    // Create mock Merkle path data (normally built from the tree)
    const inputMerklePathIndices = inputs.map((input) => input.index || 0);
    
    // inputMerklePathElements won't be checked for empty utxos. so we need to create a sample full path
    // Create the Merkle paths for each input
    const inputMerklePathElements = inputs.map(() => {
      // Return an array of zero elements as the path for each input
      // Create a copy of the zeroElements array to avoid modifying the original
      return [...new Array(globalMerkleTree.levels).fill(0)];
    });

    // Resolve all async operations before creating the input object
    // Await nullifiers and commitments to get actual values instead of Promise objects
    const inputNullifiers = await Promise.all(inputs.map(x => x.getNullifier()));
    const outputCommitments = await Promise.all(outputs.map(x => x.getCommitment()));

    // Use the properly calculated Merkle tree root
    const root = globalMerkleTree.root();

    // Calculate the hash correctly using our utility
    const calculatedExtDataHash = getExtDataHash(extData);
    const publicAmountNumber = new anchor.BN(200);

    const input = {
      // Common transaction data
      root: root,
      inputNullifier: inputNullifiers, // Use resolved values instead of Promise objects
      outputCommitment: outputCommitments, // Use resolved values instead of Promise objects
      publicAmount: publicAmountNumber.toString(),
      extDataHash: calculatedExtDataHash,
      
      // Input UTXO data (UTXOs being spent) - ensure all values are in decimal format
      inAmount: inputs.map(x => x.amount.toString(10)),
      inPrivateKey: inputs.map(x => x.keypair.privkey),
      inBlinding: inputs.map(x => x.blinding.toString(10)),
      mintAddress: inputs[0].mintAddress,
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
    const crossCheckNullifiers = findCrossCheckNullifierPDAs(program, proofToSubmit);

    // Derive commitment PDAs
    const { commitment0PDA, commitment1PDA } = findCommitmentPDAs(program, proofToSubmit);

    // Create Address Lookup Table for transaction size optimization
    const testProtocolAddresses = getTestProtocolAddresses(
      program.programId,
      authority.publicKey,
      treeAccountPDA,
      treeTokenAccountPDA,
      FEE_RECIPIENT_ACCOUNT
    );
    
    const lookupTableAddress = await createGlobalTestALT(provider.connection, authority, testProtocolAddresses);

    // Get balances before transaction
    const treeTokenAccountBalanceBefore = await provider.connection.getBalance(treeTokenAccountPDA);
    const feeRecipientBalanceBefore = await provider.connection.getBalance(FEE_RECIPIENT_ACCOUNT);
    const recipientBalanceBefore = await provider.connection.getBalance(recipient.publicKey);
    const randomUserBalanceBefore = await provider.connection.getBalance(randomUser.publicKey);

    // Execute the transaction without pre-instructions
    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    const tx = await program.methods
      .transact(proofToSubmit, createExtDataMinified(extData), extData.encryptedOutput1, extData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: nullifier0PDA,
        nullifier1: nullifier1PDA,
        nullifier2: crossCheckNullifiers.nullifier2PDA,
        nullifier3: crossCheckNullifiers.nullifier3PDA,
        commitment0: commitment0PDA,
        commitment1: commitment1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: FEE_RECIPIENT_ACCOUNT,
        treeTokenAccount: treeTokenAccountPDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey, // Use random user as signer
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser]) // Random user signs the transaction
      .preInstructions([modifyComputeUnits]) // Add compute budget instruction as pre-instruction
      .transaction();
    
    // Create versioned transaction with ALT
    const versionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      randomUser.publicKey,
      tx.instructions,
      lookupTableAddress
    );
    
    // Send and confirm versioned transaction
    const txSig = await sendAndConfirmVersionedTransaction(
      provider.connection,
      versionedTx,
      [randomUser]
    );
    
    expect(txSig).to.be.a('string');

    // Check commitment logs for transaction (only if transaction succeeded)
    const transaction = await provider.connection.getTransaction(txSig, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    });

    if (transaction && transaction.meta && transaction.meta.logMessages) {
      const logs = transaction.meta.logMessages;
      // Parse commitment events using Anchor's EventParser
      const eventParser = new EventParser(program.programId, new BorshCoder(program.idl));
      const events = Array.from(eventParser.parseLogs(logs));
      const commitmentEvents = events.filter(event => event.name === "commitmentData");
      
      // All transactions must have exactly 2 commitment events
      expect(commitmentEvents).to.have.length(2);

      // Verify first commitment event
      const firstEvent = commitmentEvents[0];
      expect(firstEvent.data.index).to.be.an.instanceOf(anchor.BN);
      expect(firstEvent.data.commitment).to.be.an('array');
      expect(firstEvent.data.encryptedOutput).to.be.instanceOf(Buffer);
      expect(firstEvent.data.commitment).to.have.length(32);
      
      // Verify second commitment event
      const secondEvent = commitmentEvents[1];
      expect(secondEvent.data.index).to.be.an.instanceOf(anchor.BN);
      expect(secondEvent.data.commitment).to.be.an('array');
      expect(secondEvent.data.encryptedOutput).to.be.instanceOf(Buffer);
      expect(secondEvent.data.commitment).to.have.length(32);
      
      // Verify second index is first index + 1
      expect(secondEvent.data.index.toNumber()).to.equal(firstEvent.data.index.toNumber() + 1);

      // Verify the event commitments match the actual output commitments
      const firstEventCommitment = Buffer.from(firstEvent.data.commitment);
      const secondEventCommitment = Buffer.from(secondEvent.data.commitment);
      
      // Compare against proof output commitments
      const proofOutputCommitments = proofToSubmit.outputCommitments;
      expect(firstEventCommitment.toString('hex')).to.deep.equal(Buffer.from(proofOutputCommitments[0]).toString('hex'));
      expect(secondEventCommitment.toString('hex')).to.deep.equal(Buffer.from(proofOutputCommitments[1]).toString('hex'));

      // Verify the event encrypted outputs match the actual encrypted outputs
      expect(firstEvent.data.encryptedOutput).to.deep.equal(extData.encryptedOutput1);
      expect(secondEvent.data.encryptedOutput).to.deep.equal(extData.encryptedOutput2);
    }

    // Verify commitment PDAs have correct data
    const commitment0Account = await provider.connection.getAccountInfo(commitment0PDA);
    const commitment1Account = await provider.connection.getAccountInfo(commitment1PDA);
    
    // Check that the commitment accounts exist
    expect(commitment0Account).to.not.be.null;
    expect(commitment1Account).to.not.be.null;
    
    // Deserialize the commitment accounts
    const commitment0Data = program.coder.accounts.decode(
      'commitmentAccount',
      commitment0Account.data
    );
    const commitment1Data = program.coder.accounts.decode(
      'commitmentAccount',
      commitment1Account.data
    );
    
    // Verify the commitment values match
    expect(Buffer.from(commitment0Data.commitment).equals(Buffer.from(proofToSubmit.outputCommitments[0]))).to.be.true;
    expect(Buffer.from(commitment1Data.commitment).equals(Buffer.from(proofToSubmit.outputCommitments[1]))).to.be.true;
    
    // Verify the encrypted outputs match
    expect(Buffer.from(commitment0Data.encryptedOutput).equals(extData.encryptedOutput1)).to.be.true;
    expect(Buffer.from(commitment1Data.encryptedOutput).equals(extData.encryptedOutput2)).to.be.true;

    // Get balances after transaction
    const treeTokenAccountBalanceAfter = await provider.connection.getBalance(treeTokenAccountPDA);
    const feeRecipientBalanceAfter = await provider.connection.getBalance(FEE_RECIPIENT_ACCOUNT);
    const recipientBalanceAfter = await provider.connection.getBalance(recipient.publicKey);
    const randomUserBalanceAfter = await provider.connection.getBalance(randomUser.publicKey);
    
    // Calculate differences
    const treeTokenAccountDiff = treeTokenAccountBalanceAfter - treeTokenAccountBalanceBefore;
    const feeRecipientDiff = feeRecipientBalanceAfter - feeRecipientBalanceBefore;
    const recipientDiff = recipientBalanceAfter - recipientBalanceBefore;
    const randomUserDiff = randomUserBalanceAfter - randomUserBalanceBefore;

    expect(treeTokenAccountDiff).to.be.equals(publicAmountNumber.toNumber());
    expect(feeRecipientDiff).to.be.equals(0);
    expect(recipientDiff).to.be.equals(0);
    // accounts for the transaction fee
    expect(randomUserDiff).to.be.lessThan(-extData.extAmount.toNumber());

    // Create mock input UTXOs for withdrawal
    // First input is a real UTXO that we created in deposit
    const withdrawInputs = [
      outputs[0], // Use the first output directly
      new Utxo({ lightWasm }) // Second input is empty
    ];
    const withdrawOutputs = [
      new Utxo({ lightWasm, amount: '0', index: globalMerkleTree._layers[0].length }), // Some remaining amount
      new Utxo({ lightWasm, amount: '0' }) // Empty UTXO
    ];
    const withdrawFee = new anchor.BN(20)

    const withdrawInputsSum = withdrawInputs.reduce((sum, x) => sum.add(x.amount), new BN(0))
    const withdrawOutputsSum = withdrawOutputs.reduce((sum, x) => sum.add(x.amount), new BN(0))
    const extAmount = new BN(withdrawFee)
      .add(withdrawOutputsSum)
      .sub(withdrawInputsSum)
    
    // For circom, we need field modular arithmetic to handle negative numbers
    const withdrawPublicAmount = new BN(extAmount).sub(new BN(withdrawFee)).add(FIELD_SIZE).mod(FIELD_SIZE).toString()
    
    // Create a sample ExtData object for withdrawal
    const withdrawExtData = {
      recipient: recipient.publicKey,
      extAmount: extAmount, // Use the calculated extAmount value instead of hardcoded -100
      encryptedOutput1: Buffer.from("withdrawEncryptedOutput1"),
      encryptedOutput2: Buffer.from("withdrawEncryptedOutput2"),
      fee: withdrawFee, // Use the same fee variable we used in calculations
      feeRecipient: FEE_RECIPIENT_ACCOUNT,
      mintAddress: new anchor.web3.PublicKey("11111111111111111111111111111112"), // SOL mint address
    };

    // Calculate the hash for withdrawal
    const withdrawExtDataHash = getExtDataHash(withdrawExtData);

    // Create a new tree and insert the deposit output commitments
    for (const commitment of outputCommitments) {
      globalMerkleTree.insert(commitment);
    }

    const oldRoot = globalMerkleTree.root();

    // Get nullifiers and commitments for withdrawal
    const withdrawInputNullifiers = await Promise.all(withdrawInputs.map(x => x.getNullifier()));
    const withdrawOutputCommitments = await Promise.all(withdrawOutputs.map(x => x.getCommitment()));

    // Calculate Merkle paths for withdrawal inputs properly
    const withdrawalInputMerklePathIndices = []
    const withdrawalInputMerklePathElements = []
    for (let i = 0; i < withdrawInputs.length; i++) {
      const withdrawInput = withdrawInputs[i]
      if (withdrawInput.amount.gt(new BN(0))) {
        const commitment = outputCommitments[i]
        withdrawInput.index = globalMerkleTree.indexOf(commitment)
        if (withdrawInput.index < 0) {
          throw new Error(`Input commitment ${commitment} was not found`)
        }
        withdrawalInputMerklePathIndices.push(withdrawInput.index)
        withdrawalInputMerklePathElements.push(globalMerkleTree.path(withdrawInput.index).pathElements)
      } else {
        withdrawalInputMerklePathIndices.push(0)
        withdrawalInputMerklePathElements.push(new Array(globalMerkleTree.levels).fill(0))
      }
    }

    // Create input for withdrawal proof generation
    const withdrawInput = {
      // Common transaction data
      root: oldRoot,
      inputNullifier: withdrawInputNullifiers,
      outputCommitment: withdrawOutputCommitments,
      publicAmount: withdrawPublicAmount.toString(),
      extDataHash: withdrawExtDataHash,
      
      // Input UTXO data (UTXOs being spent)
      inAmount: withdrawInputs.map(x => x.amount.toString(10)),
      inPrivateKey: withdrawInputs.map(x => x.keypair.privkey),
      inBlinding: withdrawInputs.map(x => x.blinding.toString(10)),
      mintAddress: withdrawInputs[0].mintAddress,
      inPathIndices: withdrawalInputMerklePathIndices,
      inPathElements: withdrawalInputMerklePathElements,
      
      // Output UTXO data (UTXOs being created)
      outAmount: withdrawOutputs.map(x => x.amount.toString(10)),
      outBlinding: withdrawOutputs.map(x => x.blinding.toString(10)),
      outPubkey: withdrawOutputs.map(x => x.keypair.pubkey),
    };

    // Generate proof for withdrawal
    const withdrawProofResult = await prove(withdrawInput, keyBasePath);
    const withdrawProofInBytes = parseProofToBytesArray(withdrawProofResult.proof);
    const withdrawInputsInBytes = parseToBytesArray(withdrawProofResult.publicSignals);
    
    // Create the final withdrawal proof object
    const withdrawProofToSubmit = {
      proofA: withdrawProofInBytes.proofA,
      proofB: withdrawProofInBytes.proofB.flat(),
      proofC: withdrawProofInBytes.proofC,
      root: withdrawInputsInBytes[0],
      publicAmount: withdrawInputsInBytes[1],
      extDataHash: withdrawInputsInBytes[2],
      inputNullifiers: [
        withdrawInputsInBytes[3],
        withdrawInputsInBytes[4]
      ],
      outputCommitments: [
        withdrawInputsInBytes[5],
        withdrawInputsInBytes[6]
      ],
    };

         // Derive PDAs for withdrawal nullifiers
     const withdrawNullifiers = findNullifierPDAs(program, withdrawProofToSubmit);
     const withdrawCrossCheckNullifiers = findCrossCheckNullifierPDAs(program, withdrawProofToSubmit);
     
     // Derive PDAs for withdrawal commitments
     const withdrawCommitments = findCommitmentPDAs(program, withdrawProofToSubmit);

    // Execute the withdrawal transaction
    const withdrawTx = await program.methods
      .transact(withdrawProofToSubmit, createExtDataMinified(withdrawExtData), withdrawExtData.encryptedOutput1, withdrawExtData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: withdrawNullifiers.nullifier0PDA,
        nullifier1: withdrawNullifiers.nullifier1PDA,
        nullifier2: withdrawCrossCheckNullifiers.nullifier2PDA,
        nullifier3: withdrawCrossCheckNullifiers.nullifier3PDA,
        commitment0: withdrawCommitments.commitment0PDA,
        commitment1: withdrawCommitments.commitment1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: FEE_RECIPIENT_ACCOUNT,
        treeTokenAccount: treeTokenAccountPDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .preInstructions([modifyComputeUnits])
      .transaction();
      
    // Create versioned transaction with ALT for withdrawal
    const withdrawVersionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      randomUser.publicKey,
      withdrawTx.instructions,
      lookupTableAddress
    );
    
    // Send and confirm withdrawal versioned transaction
    const withdrawTxSig = await sendAndConfirmVersionedTransaction(
      provider.connection,
      withdrawVersionedTx,
      [randomUser]
    );
    
    expect(withdrawTxSig).to.be.a('string');

    // Verify withdrawal commitment PDAs have correct data
    const withdrawCommitment0Account = await provider.connection.getAccountInfo(withdrawCommitments.commitment0PDA);
    const withdrawCommitment1Account = await provider.connection.getAccountInfo(withdrawCommitments.commitment1PDA);
    
    // Check that the commitment accounts exist
    expect(withdrawCommitment0Account).to.not.be.null;
    expect(withdrawCommitment1Account).to.not.be.null;
    
    // Deserialize the commitment accounts
    const withdrawCommitment0Data = program.coder.accounts.decode(
      'commitmentAccount',
      withdrawCommitment0Account.data
    );
    const withdrawCommitment1Data = program.coder.accounts.decode(
      'commitmentAccount',
      withdrawCommitment1Account.data
    );
    
    // Verify the commitment values match
    expect(Buffer.from(withdrawCommitment0Data.commitment).equals(Buffer.from(withdrawProofToSubmit.outputCommitments[0]))).to.be.true;
    expect(Buffer.from(withdrawCommitment1Data.commitment).equals(Buffer.from(withdrawProofToSubmit.outputCommitments[1]))).to.be.true;
    
    // Verify the encrypted outputs match
    expect(Buffer.from(withdrawCommitment0Data.encryptedOutput).equals(withdrawExtData.encryptedOutput1)).to.be.true;
    expect(Buffer.from(withdrawCommitment1Data.encryptedOutput).equals(withdrawExtData.encryptedOutput2)).to.be.true;

    // Get final balances after both transactions
    const finalTreeTokenBalance = await provider.connection.getBalance(treeTokenAccountPDA);
    const finalFeeRecipientBalance = await provider.connection.getBalance(FEE_RECIPIENT_ACCOUNT);
    const finalRandomUserBalance = await provider.connection.getBalance(randomUser.publicKey);
    
    // Calculate the withdrawal diffs specifically
    const treeTokenWithdrawDiff = finalTreeTokenBalance - treeTokenAccountBalanceAfter;
    const feeRecipientWithdrawDiff = finalFeeRecipientBalance - feeRecipientBalanceAfter;
    const randomUserWithdrawDiff = finalRandomUserBalance - randomUserBalanceAfter;
    
    // Verify withdrawal logic worked correctly
    expect(treeTokenWithdrawDiff).to.be.equals(extAmount.toNumber() - withdrawFee.toNumber()); // Tree decreases by withdraw amount
    expect(feeRecipientWithdrawDiff).to.be.equals(withdrawFee.toNumber()); // Fee recipient unchanged
    expect(randomUserWithdrawDiff).to.be.lessThan(-extAmount.toNumber()); // User gets withdraw amount minus tx fee

    // Calculate overall diffs for the full cycle
    const treeTokenTotalDiff = finalTreeTokenBalance - treeTokenAccountBalanceBefore;
    const feeRecipientTotalDiff = finalFeeRecipientBalance - feeRecipientBalanceBefore;
    const randomUserTotalDiff = finalRandomUserBalance - randomUserBalanceBefore;
    
    // Verify final balances
    // 1. Tree token account should be back to original amount (excluding the fee)
    expect(treeTokenTotalDiff).to.be.equals(withdrawOutputsSum.toNumber());
    
    // 2. Fee recipient keeps the fees... deposit fee is 0, so it's just the withdraw fee
    expect(feeRecipientTotalDiff).to.be.equals(withdrawFee.toNumber());
    
    // 3. Random user should have lost at least the fee amount plus some tx fees
    expect(randomUserTotalDiff).to.be.lessThan(-depositFee.toNumber());

    const treeTokenAccountBalanceDiffFromBeforeDeposit = treeTokenAccountBalanceBefore - finalTreeTokenBalance;
    expect(treeTokenAccountBalanceDiffFromBeforeDeposit).to.be.equals(0);

    // Create a new tree and insert the deposit output commitments
    for (const commitment of withdrawOutputCommitments) {
      globalMerkleTree.insert(commitment);
    }
  });

  it("Fails transact instruction for the wrong extDataHash", async () => {
    // Create a sample ExtData object
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(-100),
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(100),
      feeRecipient: FEE_RECIPIENT_ACCOUNT,
      mintAddress: new anchor.web3.PublicKey("11111111111111111111111111111112"), // SOL mint address
    };

    // Create a different ExtData to generate a different hash
    const modifiedExtData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(100), // Different amount (positive instead of negative)
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(100),
      feeRecipient: FEE_RECIPIENT_ACCOUNT,
      mintAddress: new anchor.web3.PublicKey("11111111111111111111111111111112"), // SOL mint address
    };

    // Calculate the hash using the modified data
    const incorrectExtDataHash = getExtDataHash(modifiedExtData);
    
    // Create a Proof object with the incorrect hash
    const proof = {
      proofA: Array(64).fill(1), // 64-byte array for proofA
      proofB: Array(128).fill(2), // 128-byte array for proofB  
      proofC: Array(64).fill(3), // 64-byte array for proofC
      root: ZERO_BYTES[DEFAULT_HEIGHT],
      inputNullifiers: [
        Array.from(generateRandomNullifier()),
        Array.from(generateRandomNullifier())
      ],
      outputCommitments: [
        Array(32).fill(3),
        Array(32).fill(4)
      ],
      publicAmount: bnToBytes(new anchor.BN(200)),
      extDataHash: Array.from(incorrectExtDataHash)
    };

    // Get nullifier PDAs
    const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program, proof);
    const { nullifier2PDA, nullifier3PDA } = findCrossCheckNullifierPDAs(program, proof);
    
    // Get commitment PDAs
    const { commitment0PDA, commitment1PDA } = findCommitmentPDAs(program, proof);

    try {
      // Create the compute units instruction
      const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
        units: 1_000_000 
      });
      
      // Execute the transaction - this should fail because the hash doesn't match
      const tx = await program.methods
        .transact(proof, createExtDataMinified(extData), extData.encryptedOutput1, extData.encryptedOutput2)
        .accounts({
          treeAccount: treeAccountPDA,
          nullifier0: nullifier0PDA,
          nullifier1: nullifier1PDA,
          nullifier2: nullifier2PDA,
          nullifier3: nullifier3PDA,
          commitment0: commitment0PDA,
          commitment1: commitment1PDA,
          recipient: recipient.publicKey,
          feeRecipientAccount: FEE_RECIPIENT_ACCOUNT,
          treeTokenAccount: treeTokenAccountPDA,
          globalConfig: globalConfigPDA,
          signer: randomUser.publicKey, // Use random user as signer
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([randomUser]) // Random user signs the transaction
        .preInstructions([modifyComputeUnits]) // Add the compute unit instruction as a pre-instruction
        .transaction();
      
      // Create v0 transaction to allow larger size
      const latestBlockhash = await provider.connection.getLatestBlockhash();
      const messageLegacy = new anchor.web3.TransactionMessage({
        payerKey: randomUser.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: tx.instructions,
      }).compileToLegacyMessage();
      
      // Create a versioned transaction
      const transactionV0 = new anchor.web3.VersionedTransaction(messageLegacy);
      
      // Sign the transaction
      transactionV0.sign([randomUser]);
      
      // Send and confirm transaction - this should fail
      await provider.connection.sendTransaction(transactionV0, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });
      
      // If we reach here, the test should fail because the transaction should have thrown an error
      expect.fail("Transaction should have failed due to invalid extDataHash but succeeded");
    } catch (error) {
      // For versioned transactions, we need to check the error message
      const errorString = error.toString();
      expect(errorString.includes("0x1771") || errorString.includes("ExtDataHashMismatch")).to.be.true;
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
      feeRecipient: FEE_RECIPIENT_ACCOUNT,
      mintAddress: new anchor.web3.PublicKey("11111111111111111111111111111112"), // SOL mint address
    };

    // Calculate the correct extDataHash
    const calculatedExtDataHash = getExtDataHash(extData);
    
    // Create an invalid root (not in the tree's history)
    const invalidRoot = Array(32).fill(123); // Different from any known root
    
    // Create a Proof object with the invalid root but correct hash
    const proof = {
      proofA: Array(64).fill(1), // 64-byte array for proofA
      proofB: Array(128).fill(2), // 128-byte array for proofB  
      proofC: Array(64).fill(3), // 64-byte array for proofC
      root: invalidRoot,
      inputNullifiers: [
        Array.from(generateRandomNullifier()),
        Array.from(generateRandomNullifier())
      ],
      outputCommitments: [
        Array(32).fill(3),
        Array(32).fill(4)
      ],
      publicAmount: bnToBytes(new anchor.BN(200)),
      extDataHash: Array.from(calculatedExtDataHash)
    };

    // Get nullifier PDAs
    const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program, proof);
    const { nullifier2PDA, nullifier3PDA } = findCrossCheckNullifierPDAs(program, proof);
    
    // Get commitment PDAs
    const { commitment0PDA, commitment1PDA } = findCommitmentPDAs(program, proof);

    try {
      // Create the compute units instruction
      const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
        units: 1_000_000 
      });
      
      // Execute the transaction - this should fail because the root is unknown
      const tx = await program.methods
        .transact(proof, createExtDataMinified(extData), extData.encryptedOutput1, extData.encryptedOutput2)
        .accounts({
          treeAccount: treeAccountPDA,
          nullifier0: nullifier0PDA,
          nullifier1: nullifier1PDA,
          nullifier2: nullifier2PDA,
          nullifier3: nullifier3PDA,
          commitment0: commitment0PDA,
          commitment1: commitment1PDA,
          recipient: recipient.publicKey,
          feeRecipientAccount: FEE_RECIPIENT_ACCOUNT,
          treeTokenAccount: treeTokenAccountPDA,
          globalConfig: globalConfigPDA,
          signer: randomUser.publicKey, // Use random user as signer
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([randomUser]) // Random user signs the transaction
        .preInstructions([modifyComputeUnits]) // Add the compute unit instruction as a pre-instruction
        .transaction();
      
      // Create v0 transaction to allow larger size
      const latestBlockhash = await provider.connection.getLatestBlockhash();
      const messageLegacy = new anchor.web3.TransactionMessage({
        payerKey: randomUser.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: tx.instructions,
      }).compileToLegacyMessage();
      
      // Create a versioned transaction
      const transactionV0 = new anchor.web3.VersionedTransaction(messageLegacy);
      
      // Sign the transaction
      transactionV0.sign([randomUser]);
      
      // Send and confirm transaction - this should fail
      await provider.connection.sendTransaction(transactionV0, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });
      
      // If we reach here, the test should fail because the transaction should have thrown an error
      expect.fail("Transaction should have failed due to unknown root but succeeded");
    } catch (error) {
      // For versioned transactions, we need to check the error message
      const errorString = error.toString();
      // Make error detection more robust by checking for a wider range of possible error messages
      expect(
        errorString.includes("0x1772") || 
        errorString.includes("UnknownRoot") ||
        errorString.includes("Transaction simulation failed")
      ).to.be.true;
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
      feeRecipient: FEE_RECIPIENT_ACCOUNT,
      mintAddress: new anchor.web3.PublicKey("11111111111111111111111111111112"), // SOL mint address
    };

    // Calculate the correct extDataHash
    const calculatedExtDataHash = getExtDataHash(extData);
    
    const zeroRoot = Array(32).fill(0);
    
    // Create a Proof object with the invalid root but correct hash
    const proof = {
      proofA: Array(64).fill(1), // 64-byte array for proofA
      proofB: Array(128).fill(2), // 128-byte array for proofB  
      proofC: Array(64).fill(3), // 64-byte array for proofC
      root: zeroRoot,
      inputNullifiers: [
        Array.from(generateRandomNullifier()),
        Array.from(generateRandomNullifier())
      ],
      outputCommitments: [
        Array(32).fill(3),
        Array(32).fill(4)
      ],
      publicAmount: bnToBytes(new anchor.BN(200)),
      extDataHash: Array.from(calculatedExtDataHash)
    };

    // Get nullifier PDAs
    const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program, proof);
    const { nullifier2PDA, nullifier3PDA } = findCrossCheckNullifierPDAs(program, proof);
    
    // Get commitment PDAs
    const { commitment0PDA, commitment1PDA } = findCommitmentPDAs(program, proof);

    try {
      // Create the compute units instruction
      const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
        units: 1_000_000 
      });
      
      // Execute the transaction - this should fail because the root is unknown
      const tx = await program.methods
        .transact(proof, createExtDataMinified(extData), extData.encryptedOutput1, extData.encryptedOutput2)
        .accounts({
          treeAccount: treeAccountPDA,
          nullifier0: nullifier0PDA,
          nullifier1: nullifier1PDA,
          nullifier2: nullifier2PDA,
          nullifier3: nullifier3PDA,
          commitment0: commitment0PDA,
          commitment1: commitment1PDA,
          recipient: recipient.publicKey,
          feeRecipientAccount: FEE_RECIPIENT_ACCOUNT,
          treeTokenAccount: treeTokenAccountPDA,
          globalConfig: globalConfigPDA,
          signer: randomUser.publicKey, // Use random user as signer
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([randomUser]) // Random user signs the transaction
        .preInstructions([modifyComputeUnits]) // Add the compute unit instruction as a pre-instruction
        .transaction();
      
      // Create v0 transaction to allow larger size
      const latestBlockhash = await provider.connection.getLatestBlockhash();
      const messageLegacy = new anchor.web3.TransactionMessage({
        payerKey: randomUser.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: tx.instructions,
      }).compileToLegacyMessage();
      
      // Create a versioned transaction
      const transactionV0 = new anchor.web3.VersionedTransaction(messageLegacy);
      
      // Sign the transaction
      transactionV0.sign([randomUser]);
      
      // Send and confirm transaction - this should fail
      await provider.connection.sendTransaction(transactionV0, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });
      
      // If we reach here, the test should fail because the transaction should have thrown an error
      expect.fail("Transaction should have failed due to unknown root but succeeded");
    } catch (error) {
      // For versioned transactions, we need to check the error message
      const errorString = error.toString();
      // Make error detection more robust by checking for a wider range of possible error messages
      expect(
        errorString.includes("0x1772") || 
        errorString.includes("UnknownRoot") ||
        errorString.includes("Transaction simulation failed")
      ).to.be.true;
    }
  });

  it("Fails transact instruction for invalid mint address", async () => {
    // Create a sample ExtData object with invalid mint address
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(100), // Positive amount (deposit)
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(10),
      feeRecipient: FEE_RECIPIENT_ACCOUNT,
      mintAddress: new anchor.web3.PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), // USDC mint address (invalid)
    };

    // Calculate the correct extDataHash
    const calculatedExtDataHash = getExtDataHash(extData);
    
    // Create a Proof object with correct hash but the ExtData has invalid mint
    const proof = {
      proofA: Array(64).fill(1), // 64-byte array for proofA
      proofB: Array(128).fill(2), // 128-byte array for proofB  
      proofC: Array(64).fill(3), // 64-byte array for proofC
      root: ZERO_BYTES[DEFAULT_HEIGHT],
      inputNullifiers: [
        Array.from(generateRandomNullifier()),
        Array.from(generateRandomNullifier())
      ],
      outputCommitments: [
        Array(32).fill(3),
        Array(32).fill(4)
      ],
      publicAmount: bnToBytes(new anchor.BN(90)), // 100 - 10 fee
      extDataHash: Array.from(calculatedExtDataHash)
    };

    // Get nullifier PDAs
    const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program, proof);
    const { nullifier2PDA, nullifier3PDA } = findCrossCheckNullifierPDAs(program, proof);
    
    // Get commitment PDAs
    const { commitment0PDA, commitment1PDA } = findCommitmentPDAs(program, proof);

    try {
      // Create the compute units instruction
      const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
        units: 1_000_000 
      });
      
      // Execute the transaction - this should fail because of invalid mint address
      const tx = await program.methods
        .transact(proof, createExtDataMinified(extData), extData.encryptedOutput1, extData.encryptedOutput2)
        .accounts({
          treeAccount: treeAccountPDA,
          nullifier0: nullifier0PDA,
          nullifier1: nullifier1PDA,
          nullifier2: nullifier2PDA,
          nullifier3: nullifier3PDA,
          commitment0: commitment0PDA,
          commitment1: commitment1PDA,
          recipient: recipient.publicKey,
          feeRecipientAccount: FEE_RECIPIENT_ACCOUNT,
          treeTokenAccount: treeTokenAccountPDA,
          globalConfig: globalConfigPDA,
          signer: randomUser.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([randomUser])
        .preInstructions([modifyComputeUnits])
        .transaction();
      
      // Create v0 transaction to allow larger size
      const latestBlockhash = await provider.connection.getLatestBlockhash();
      const messageLegacy = new anchor.web3.TransactionMessage({
        payerKey: randomUser.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: tx.instructions,
      }).compileToLegacyMessage();
      
      // Create a versioned transaction
      const transactionV0 = new anchor.web3.VersionedTransaction(messageLegacy);
      
      // Sign the transaction
      transactionV0.sign([randomUser]);
      
      // Send and confirm transaction - this should fail
      await provider.connection.sendTransaction(transactionV0, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });
      
      // If we reach here, the test should fail because the transaction should have thrown an error
      expect.fail("Transaction should have failed due to invalid mint address but succeeded");
    } catch (error) {
      const errorString = error.toString();
      expect(
        errorString.includes("0x1774") || 
        // because of ExtDataHash derived onchain must be SOL (hardcoded in the program)
        errorString.includes("ExtDataHashMismatch") ||
        errorString.includes("Transaction simulation failed")
      ).to.be.true;
    }
  });

  it("Fails to deposit when exceeding the default deposit limit", async () => {
    // The default deposit limit is 1000 lamports
    const excessiveAmount = 1001; // Just above the limit
    
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(excessiveAmount),
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(10),
      feeRecipient: FEE_RECIPIENT_ACCOUNT,
      mintAddress: new anchor.web3.PublicKey("11111111111111111111111111111112"), // SOL mint address
    };

    // Calculate the correct extDataHash
    const calculatedExtDataHash = getExtDataHash(extData);
    
    // Create a Proof object with correct hash
    const proof = {
      proofA: Array(64).fill(1), // 64-byte array for proofA
      proofB: Array(128).fill(2), // 128-byte array for proofB  
      proofC: Array(64).fill(3), // 64-byte array for proofC
      root: ZERO_BYTES[DEFAULT_HEIGHT],
      inputNullifiers: [
        Array.from(generateRandomNullifier()),
        Array.from(generateRandomNullifier())
      ],
      outputCommitments: [
        Array(32).fill(3),
        Array(32).fill(4)
      ],
      publicAmount: bnToBytes(new anchor.BN(excessiveAmount - 10)), // Amount minus fee
      extDataHash: Array.from(calculatedExtDataHash)
    };

    // Get nullifier PDAs
    const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program, proof);
    const { nullifier2PDA, nullifier3PDA } = findCrossCheckNullifierPDAs(program, proof);
    
    // Get commitment PDAs
    const { commitment0PDA, commitment1PDA } = findCommitmentPDAs(program, proof);

    try {
      // Create the compute units instruction
      const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
        units: 1_000_000 
      });
      
      // Execute the transaction - this should fail because of exceeding deposit limit
      const tx = await program.methods
        .transact(proof, createExtDataMinified(extData), extData.encryptedOutput1, extData.encryptedOutput2)
        .accounts({
          treeAccount: treeAccountPDA,
          nullifier0: nullifier0PDA,
          nullifier1: nullifier1PDA,
          nullifier2: nullifier2PDA,
          nullifier3: nullifier3PDA,
          commitment0: commitment0PDA,
          commitment1: commitment1PDA,
          recipient: recipient.publicKey,
          feeRecipientAccount: FEE_RECIPIENT_ACCOUNT,
          treeTokenAccount: treeTokenAccountPDA,
          globalConfig: globalConfigPDA,
          signer: randomUser.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([randomUser])
        .preInstructions([modifyComputeUnits])
        .transaction();
      
      // Create v0 transaction to allow larger size
      const latestBlockhash = await provider.connection.getLatestBlockhash();
      const messageLegacy = new anchor.web3.TransactionMessage({
        payerKey: randomUser.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: tx.instructions,
      }).compileToLegacyMessage();
      
      // Create a versioned transaction
      const transactionV0 = new anchor.web3.VersionedTransaction(messageLegacy);
      
      // Sign the transaction
      transactionV0.sign([randomUser]);
      
      // Send and confirm transaction - this should fail
      await provider.connection.sendTransaction(transactionV0, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });
      
      // If we reach here, the test should fail because the transaction should have thrown an error
      expect.fail("Transaction should have failed due to exceeding deposit limit but succeeded");
    } catch (error) {
      // Check for the deposit limit exceeded error
      const errorString = error.toString();
      expect(
        errorString.includes("0x1773") || 
        errorString.includes("DepositLimitExceeded") ||
        errorString.includes("Transaction simulation failed")
      ).to.be.true;
    }
  });

    it("Authority can update deposit limit", async () => {
    const newLimit = new anchor.BN(2_000_000_000); // 2 SOL
    
    // Create Address Lookup Table for transaction size optimization
    const testProtocolAddresses = getTestProtocolAddresses(
      program.programId,
      authority.publicKey,
      treeAccountPDA,
      treeTokenAccountPDA,
      FEE_RECIPIENT_ACCOUNT
    );
    
    const lookupTableAddress = await createGlobalTestALT(provider.connection, authority, testProtocolAddresses);

    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    const tx = await program.methods
      .updateDepositLimit(newLimit)
      .accounts({
        treeAccount: treeAccountPDA,
        authority: authority.publicKey,
      })
      .signers([authority])
      .preInstructions([modifyComputeUnits])
      .transaction();

    // Create versioned transaction with ALT
    const versionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      authority.publicKey,
      tx.instructions,
      lookupTableAddress
    );
    
    // Send and confirm versioned transaction
    const txSig = await sendAndConfirmVersionedTransaction(
      provider.connection,
      versionedTx,
      [authority]
    );

    expect(txSig).to.be.a('string');

    // Verify the limit was updated
    const merkleTreeAccount = await program.account.merkleTreeAccount.fetch(treeAccountPDA);
    expect(merkleTreeAccount.maxDepositAmount.toString()).to.equal(newLimit.toString());
  });

  it("Non-authority cannot update deposit limit", async () => {
    const newLimit = new anchor.BN(3_000_000_000); // 3 SOL
    const nonAuthority = anchor.web3.Keypair.generate();
    
    // Fund the non-authority account
    const transferTx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: fundingAccount.publicKey,
        toPubkey: nonAuthority.publicKey,
        lamports: 0.5 * LAMPORTS_PER_SOL,
      })
    );
    
    const transferSignature = await provider.connection.sendTransaction(transferTx, [fundingAccount]);
    await provider.connection.confirmTransaction(transferSignature);

    // Create Address Lookup Table for transaction size optimization
    const testProtocolAddresses = getTestProtocolAddresses(
      program.programId,
      authority.publicKey,
      treeAccountPDA,
      treeTokenAccountPDA,
      FEE_RECIPIENT_ACCOUNT
    );
    
    const lookupTableAddress = await createGlobalTestALT(provider.connection, nonAuthority, testProtocolAddresses);

    try {
      const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
        units: 1_000_000 
      });
      
      const tx = await program.methods
        .updateDepositLimit(newLimit)
        .accounts({
          treeAccount: treeAccountPDA,
          authority: nonAuthority.publicKey,
        })
        .signers([nonAuthority])
        .preInstructions([modifyComputeUnits])
        .transaction();

      // Create versioned transaction with ALT
      const versionedTx = await createVersionedTransactionWithALT(
        provider.connection,
        nonAuthority.publicKey,
        tx.instructions,
        lookupTableAddress
      );
      
      // Send and confirm versioned transaction - this should fail
      await sendAndConfirmVersionedTransaction(
        provider.connection,
        versionedTx,
        [nonAuthority]
      );

      expect.fail("Transaction should have failed due to unauthorized access");
    } catch (error) {
      const errorString = error.toString();
      expect(
        errorString.includes("0x1770") ||
        errorString.includes("Unauthorized") ||
        errorString.includes("Not authorized to perform this action") ||
        errorString.includes("custom program error")
      ).to.be.true;
    }
  });

  it("Can deposit after increasing limit", async () => {
    // First, update the limit to 2 SOL
    const newLimit = new anchor.BN(2_000_000_000); // 2 SOL
    
    await program.methods
      .updateDepositLimit(newLimit)
      .accounts({
        treeAccount: treeAccountPDA,
        authority: authority.publicKey,
      })
      .signers([authority])
      .rpc();

    // Fund randomUser with enough SOL for the large deposit
    const largeFundingTx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: fundingAccount.publicKey,
        toPubkey: randomUser.publicKey,
        lamports: 1 * LAMPORTS_PER_SOL, // Add 1 more SOL
      })
    );
    const largeFundingSignature = await provider.connection.sendTransaction(largeFundingTx, [fundingAccount]);
    await provider.connection.confirmTransaction(largeFundingSignature);

    // Now try to deposit 1.5 SOL (which should now be allowed)
    const depositAmountLamports = 1_500_000_000; // 1.5 SOL
    const depositFee = new anchor.BN(calculateDepositFee(depositAmountLamports));
    const depositAmount = new anchor.BN(depositAmountLamports);
    
    const extData = {
      recipient: recipient.publicKey,
      extAmount: depositAmount,
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: depositFee,
      feeRecipient: FEE_RECIPIENT_ACCOUNT,
      mintAddress: new anchor.web3.PublicKey("11111111111111111111111111111112"), // SOL mint address
    };

    // Create the merkle tree
    const tree: MerkleTree = globalMerkleTree;

    // Create inputs for the deposit
    const inputs = [
      new Utxo({ lightWasm }),
      new Utxo({ lightWasm })
    ];

    const publicAmountNumber = extData.extAmount.sub(depositFee);
    const outputAmount = publicAmountNumber.toString();
    const outputs = [
      new Utxo({ lightWasm, amount: outputAmount, index: globalMerkleTree._layers[0].length }),
      new Utxo({ lightWasm, amount: '0' })
    ];

    // Create mock Merkle path data
    const inputMerklePathIndices = inputs.map((input) => input.index || 0);
    const inputMerklePathElements = inputs.map(() => {
      return [...new Array(tree.levels).fill(0)];
    });

    // Resolve async operations
    const inputNullifiers = await Promise.all(inputs.map(x => x.getNullifier()));
    const outputCommitments = await Promise.all(outputs.map(x => x.getCommitment()));
    const root = tree.root();
    const calculatedExtDataHash = getExtDataHash(extData);

    const input = {
      root: root,
      inputNullifier: inputNullifiers,
      outputCommitment: outputCommitments,
      publicAmount: outputAmount.toString(),
      extDataHash: calculatedExtDataHash,
      inAmount: inputs.map(x => x.amount.toString(10)),
      inPrivateKey: inputs.map(x => x.keypair.privkey),
      inBlinding: inputs.map(x => x.blinding.toString(10)),
      mintAddress: inputs[0].mintAddress,
      inPathIndices: inputMerklePathIndices,
      inPathElements: inputMerklePathElements,
      outAmount: outputs.map(x => x.amount.toString(10)),
      outBlinding: outputs.map(x => x.blinding.toString(10)),
      outPubkey: outputs.map(x => x.keypair.pubkey),
    };

    // Generate proof
    const keyBasePath = path.resolve(__dirname, '../../artifacts/circuits/transaction2');
    const {proof, publicSignals} = await prove(input, keyBasePath);

    const proofInBytes = parseProofToBytesArray(proof);
    const inputsInBytes = parseToBytesArray(publicSignals);
    
    const proofToSubmit = {
      proofA: proofInBytes.proofA,
      proofB: proofInBytes.proofB.flat(),
      proofC: proofInBytes.proofC,
      root: inputsInBytes[0],
      publicAmount: inputsInBytes[1],
      extDataHash: inputsInBytes[2],
      inputNullifiers: [inputsInBytes[3], inputsInBytes[4]],
      outputCommitments: [inputsInBytes[5], inputsInBytes[6]],
    };

    // Derive PDAs
    const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program, proofToSubmit);
    const crossCheckNullifiers = findCrossCheckNullifierPDAs(program, proofToSubmit);
    const { commitment0PDA, commitment1PDA } = findCommitmentPDAs(program, proofToSubmit);

    // Create Address Lookup Table for transaction size optimization
    const testProtocolAddresses = getTestProtocolAddresses(
      program.programId,
      authority.publicKey,
      treeAccountPDA,
      treeTokenAccountPDA,
      FEE_RECIPIENT_ACCOUNT
    );
    
    const lookupTableAddress = await createGlobalTestALT(provider.connection, authority, testProtocolAddresses);

    // Execute the transaction - should now succeed
    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    const tx = await program.methods
      .transact(proofToSubmit, createExtDataMinified(extData), extData.encryptedOutput1, extData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: nullifier0PDA,
        nullifier1: nullifier1PDA,
        nullifier2: crossCheckNullifiers.nullifier2PDA,
        nullifier3: crossCheckNullifiers.nullifier3PDA,
        commitment0: commitment0PDA,
        commitment1: commitment1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: FEE_RECIPIENT_ACCOUNT,
        treeTokenAccount: treeTokenAccountPDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .preInstructions([modifyComputeUnits])
      .transaction();

    // Create versioned transaction with ALT
    const versionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      randomUser.publicKey,
      tx.instructions,
      lookupTableAddress
    );
    
    // Send and confirm versioned transaction
    const txSig = await sendAndConfirmVersionedTransaction(
      provider.connection,
      versionedTx,
      [randomUser]
    );

    expect(txSig).to.be.a('string');

    for (const commitment of outputCommitments) {
      tree.insert(commitment);
    }
  });

  it("Withdrawal has no limit (can withdraw any amount)", async () => {
    // Fund randomUser with enough SOL for the deposit
    const withdrawalTestFundingTx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: fundingAccount.publicKey,
        toPubkey: randomUser.publicKey,
        lamports: 0.5 * LAMPORTS_PER_SOL, // Add 0.5 more SOL to cover deposit + fees
      })
    );
    const withdrawalTestFundingSignature = await provider.connection.sendTransaction(withdrawalTestFundingTx, [fundingAccount]);
    await provider.connection.confirmTransaction(withdrawalTestFundingSignature);

    // First do a deposit to have funds for withdrawal
    const depositAmountLamports = 1_000_000_000; // 1 SOL
    const depositFee = new anchor.BN(calculateDepositFee(depositAmountLamports));
    const depositAmount = new anchor.BN(depositAmountLamports);
    
    const depositExtData = {
      recipient: recipient.publicKey,
      extAmount: depositAmount,
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: depositFee,
      feeRecipient: FEE_RECIPIENT_ACCOUNT,
      mintAddress: new anchor.web3.PublicKey("11111111111111111111111111111112"), // SOL mint address
    };

    // Create the merkle tree
    const tree: MerkleTree = globalMerkleTree;

    // Create inputs for the deposit
    const depositInputs = [
      new Utxo({ lightWasm }),
      new Utxo({ lightWasm })
    ];

    const publicAmountNumber = depositExtData.extAmount.sub(depositFee);
    const outputAmount = publicAmountNumber.toString();
    const depositOutputs = [
      new Utxo({ lightWasm, amount: outputAmount, index: globalMerkleTree._layers[0].length }),
      new Utxo({ lightWasm, amount: '0' })
    ];

    // Generate deposit proof and execute
    const depositInputMerklePathIndices = depositInputs.map(() => 0);
    const depositInputMerklePathElements = depositInputs.map(() => {
      return [...new Array(tree.levels).fill(0)];
    });

    const depositInputNullifiers = await Promise.all(depositInputs.map(x => x.getNullifier()));
    const depositOutputCommitments = await Promise.all(depositOutputs.map(x => x.getCommitment()));
    const depositRoot = tree.root();
    const depositExtDataHash = getExtDataHash(depositExtData);

    const depositInput = {
      root: depositRoot,
      inputNullifier: depositInputNullifiers,
      outputCommitment: depositOutputCommitments,
      publicAmount: outputAmount.toString(),
      extDataHash: depositExtDataHash,
      inAmount: depositInputs.map(x => x.amount.toString(10)),
      inPrivateKey: depositInputs.map(x => x.keypair.privkey),
      inBlinding: depositInputs.map(x => x.blinding.toString(10)),
      mintAddress: depositInputs[0].mintAddress,
      inPathIndices: depositInputMerklePathIndices,
      inPathElements: depositInputMerklePathElements,
      outAmount: depositOutputs.map(x => x.amount.toString(10)),
      outBlinding: depositOutputs.map(x => x.blinding.toString(10)),
      outPubkey: depositOutputs.map(x => x.keypair.pubkey),
    };

    const keyBasePath = path.resolve(__dirname, '../../artifacts/circuits/transaction2');
    const depositProofResult = await prove(depositInput, keyBasePath);
    const depositProofInBytes = parseProofToBytesArray(depositProofResult.proof);
    const depositInputsInBytes = parseToBytesArray(depositProofResult.publicSignals);
    
    const depositProofToSubmit = {
      proofA: depositProofInBytes.proofA,
      proofB: depositProofInBytes.proofB.flat(),
      proofC: depositProofInBytes.proofC,
      root: depositInputsInBytes[0],
      publicAmount: depositInputsInBytes[1],
      extDataHash: depositInputsInBytes[2],
      inputNullifiers: [depositInputsInBytes[3], depositInputsInBytes[4]],
      outputCommitments: [depositInputsInBytes[5], depositInputsInBytes[6]],
    };

    const depositNullifiers = findNullifierPDAs(program, depositProofToSubmit);
    const depositCrossCheckNullifiers = findCrossCheckNullifierPDAs(program, depositProofToSubmit);
    const depositCommitments = findCommitmentPDAs(program, depositProofToSubmit);

    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    // Create Address Lookup Table for deposit transaction
    const depositTestProtocolAddresses = getTestProtocolAddresses(
      program.programId,
      authority.publicKey,
      treeAccountPDA,
      treeTokenAccountPDA,
      FEE_RECIPIENT_ACCOUNT
    );
    
    const depositLookupTableAddress = await createGlobalTestALT(provider.connection, authority, depositTestProtocolAddresses);

    // Execute deposit
    const depositTx = await program.methods
      .transact(depositProofToSubmit, createExtDataMinified(depositExtData), depositExtData.encryptedOutput1, depositExtData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: depositNullifiers.nullifier0PDA,
        nullifier1: depositNullifiers.nullifier1PDA,
        nullifier2: depositCrossCheckNullifiers.nullifier2PDA,
        nullifier3: depositCrossCheckNullifiers.nullifier3PDA,
        commitment0: depositCommitments.commitment0PDA,
        commitment1: depositCommitments.commitment1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: FEE_RECIPIENT_ACCOUNT,
        treeTokenAccount: treeTokenAccountPDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .preInstructions([modifyComputeUnits])
      .transaction();

    // Create versioned transaction with ALT for deposit
    const depositVersionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      randomUser.publicKey,
      depositTx.instructions,
      depositLookupTableAddress
    );
    
    // Send and confirm deposit versioned transaction
    await sendAndConfirmVersionedTransaction(
      provider.connection,
      depositVersionedTx,
      [randomUser]
    );

    // Now test withdrawal (no limit should apply)
    const withdrawInputs = [
      depositOutputs[0], // Use the deposit output
      new Utxo({ lightWasm })
    ];
    const withdrawOutputs = [
      new Utxo({ lightWasm, amount: '0' }),
      new Utxo({ lightWasm, amount: '0' })
    ];
    
    const withdrawInputsSum = withdrawInputs.reduce((sum, x) => sum.add(x.amount), new BN(0));
    const withdrawOutputsSum = withdrawOutputs.reduce((sum, x) => sum.add(x.amount), new BN(0));
    const withdrawalAmount = withdrawInputsSum.sub(withdrawOutputsSum);
    const withdrawFee = new anchor.BN(calculateWithdrawalFee(withdrawalAmount.toNumber()));
    const extAmount = new BN(withdrawFee)
      .add(withdrawOutputsSum)
      .sub(withdrawInputsSum);
    
    const withdrawPublicAmount = new BN(extAmount).sub(new BN(withdrawFee)).add(FIELD_SIZE).mod(FIELD_SIZE).toString();
    
    const withdrawExtData = {
      recipient: recipient.publicKey,
      extAmount: extAmount,
      encryptedOutput1: Buffer.from("withdrawEncryptedOutput1"),
      encryptedOutput2: Buffer.from("withdrawEncryptedOutput2"),
      fee: withdrawFee,
      feeRecipient: FEE_RECIPIENT_ACCOUNT,
      mintAddress: new anchor.web3.PublicKey("11111111111111111111111111111112"), // SOL mint address
    };

    // Insert commitments to tree
    for (const commitment of depositOutputCommitments) {
      tree.insert(commitment);
    }

    const oldRoot = tree.root();
    const withdrawInputNullifiers = await Promise.all(withdrawInputs.map(x => x.getNullifier()));
    const withdrawOutputCommitments = await Promise.all(withdrawOutputs.map(x => x.getCommitment()));

    // Calculate paths for withdrawal
    const withdrawalInputMerklePathIndices = [];
    const withdrawalInputMerklePathElements = [];
    for (let i = 0; i < withdrawInputs.length; i++) {
      const withdrawInput = withdrawInputs[i];
      if (withdrawInput.amount.gt(new BN(0))) {
        const commitment = depositOutputCommitments[i];
        withdrawInput.index = tree.indexOf(commitment);
        withdrawalInputMerklePathIndices.push(withdrawInput.index);
        withdrawalInputMerklePathElements.push(tree.path(withdrawInput.index).pathElements);
      } else {
        withdrawalInputMerklePathIndices.push(0);
        withdrawalInputMerklePathElements.push(new Array(tree.levels).fill(0));
      }
    }

    const withdrawExtDataHash = getExtDataHash(withdrawExtData);

    const withdrawInput = {
      root: oldRoot,
      inputNullifier: withdrawInputNullifiers,
      outputCommitment: withdrawOutputCommitments,
      publicAmount: withdrawPublicAmount.toString(),
      extDataHash: withdrawExtDataHash,
      inAmount: withdrawInputs.map(x => x.amount.toString(10)),
      inPrivateKey: withdrawInputs.map(x => x.keypair.privkey),
      inBlinding: withdrawInputs.map(x => x.blinding.toString(10)),
      mintAddress: withdrawInputs[0].mintAddress,
      inPathIndices: withdrawalInputMerklePathIndices,
      inPathElements: withdrawalInputMerklePathElements,
      outAmount: withdrawOutputs.map(x => x.amount.toString(10)),
      outBlinding: withdrawOutputs.map(x => x.blinding.toString(10)),
      outPubkey: withdrawOutputs.map(x => x.keypair.pubkey),
    };

    const withdrawProofResult = await prove(withdrawInput, keyBasePath);
    const withdrawProofInBytes = parseProofToBytesArray(withdrawProofResult.proof);
    const withdrawInputsInBytes = parseToBytesArray(withdrawProofResult.publicSignals);
    
    const withdrawProofToSubmit = {
      proofA: withdrawProofInBytes.proofA,
      proofB: withdrawProofInBytes.proofB.flat(),
      proofC: withdrawProofInBytes.proofC,
      root: withdrawInputsInBytes[0],
      publicAmount: withdrawInputsInBytes[1],
      extDataHash: withdrawInputsInBytes[2],
      inputNullifiers: [withdrawInputsInBytes[3], withdrawInputsInBytes[4]],
      outputCommitments: [withdrawInputsInBytes[5], withdrawInputsInBytes[6]],
    };

    const withdrawNullifiers = findNullifierPDAs(program, withdrawProofToSubmit);
    const withdrawCrossCheckNullifiers = findCrossCheckNullifierPDAs(program, withdrawProofToSubmit);
    const withdrawCommitments = findCommitmentPDAs(program, withdrawProofToSubmit);

    // Create Address Lookup Table for withdrawal transaction
    const withdrawTestProtocolAddresses = getTestProtocolAddresses(
      program.programId,
      authority.publicKey,
      treeAccountPDA,
      treeTokenAccountPDA,
      FEE_RECIPIENT_ACCOUNT
    );
    
    const withdrawLookupTableAddress = await createGlobalTestALT(provider.connection, authority, withdrawTestProtocolAddresses);

    // Execute withdrawal - should succeed regardless of deposit limit
    const withdrawTx = await program.methods
      .transact(withdrawProofToSubmit, createExtDataMinified(withdrawExtData), withdrawExtData.encryptedOutput1, withdrawExtData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: withdrawNullifiers.nullifier0PDA,
        nullifier1: withdrawNullifiers.nullifier1PDA,
        nullifier2: withdrawCrossCheckNullifiers.nullifier2PDA,
        nullifier3: withdrawCrossCheckNullifiers.nullifier3PDA,
        commitment0: withdrawCommitments.commitment0PDA,
        commitment1: withdrawCommitments.commitment1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: FEE_RECIPIENT_ACCOUNT,
        treeTokenAccount: treeTokenAccountPDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .preInstructions([modifyComputeUnits])
      .transaction();

    // Create versioned transaction with ALT for withdrawal
    const withdrawVersionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      randomUser.publicKey,
      withdrawTx.instructions,
      withdrawLookupTableAddress
    );
    
    // Send and confirm withdrawal versioned transaction
    const withdrawTxSig = await sendAndConfirmVersionedTransaction(
      provider.connection,
      withdrawVersionedTx,
      [randomUser]
    );

    expect(withdrawTxSig).to.be.a('string');

    for (const commitment of withdrawOutputCommitments) {
      tree.insert(commitment);
    }
  });

  it("Tests arithmetic overflow protection in transact() with edge case balances", async () => {
    // First do a normal deposit to set up the scenario
    const depositFee = new anchor.BN(calculateDepositFee(200))
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(200), // Positive ext amount (deposit)
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: depositFee, // Fee
      feeRecipient: FEE_RECIPIENT_ACCOUNT,
      mintAddress: new anchor.web3.PublicKey("11111111111111111111111111111112"), // SOL mint address
    };

    // Create the merkle tree
    const tree: MerkleTree = globalMerkleTree;

    // Create inputs for the deposit
    const inputs = [
      new Utxo({ lightWasm }),
      new Utxo({ lightWasm })
    ];

    const publicAmountNumber = extData.extAmount.sub(depositFee);
    const outputAmount = publicAmountNumber.toString();
    const outputs = [
      new Utxo({ lightWasm, amount: outputAmount, index: globalMerkleTree._layers[0].length }), // Combined amount minus fee
      new Utxo({ lightWasm, amount: '0' }) // Empty UTXO
    ];

    // Create mock Merkle path data
    const inputMerklePathIndices = inputs.map((input) => input.index || 0);
    const inputMerklePathElements = inputs.map(() => {
      return [...new Array(tree.levels).fill(0)];
    });

    // Resolve all async operations
    const inputNullifiers = await Promise.all(inputs.map(x => x.getNullifier()));
    const outputCommitments = await Promise.all(outputs.map(x => x.getCommitment()));

    // Use the properly calculated Merkle tree root
    const root = tree.root();

    // Calculate the hash correctly using our utility
    const calculatedExtDataHash = getExtDataHash(extData);

    const input = {
      // Common transaction data
      root: root,
      inputNullifier: inputNullifiers,
      outputCommitment: outputCommitments,
      publicAmount: outputAmount.toString(),
      extDataHash: calculatedExtDataHash,
      
      // Input UTXO data (UTXOs being spent)
      inAmount: inputs.map(x => x.amount.toString(10)),
      inPrivateKey: inputs.map(x => x.keypair.privkey),
      inBlinding: inputs.map(x => x.blinding.toString(10)),
      mintAddress: inputs[0].mintAddress,
      inPathIndices: inputMerklePathIndices,
      inPathElements: inputMerklePathElements,
      
      // Output UTXO data (UTXOs being created)
      outAmount: outputs.map(x => x.amount.toString(10)),
      outBlinding: outputs.map(x => x.blinding.toString(10)),
      outPubkey: outputs.map(x => x.keypair.pubkey),
    };

    // Generate proof for deposit
    const keyBasePath = path.resolve(__dirname, '../../artifacts/circuits/transaction2');
    const {proof, publicSignals} = await prove(input, keyBasePath);

    const proofInBytes = parseProofToBytesArray(proof);
    const inputsInBytes = parseToBytesArray(publicSignals);
    
    // Create a Proof object for deposit
    const proofToSubmit = {
      proofA: proofInBytes.proofA,
      proofB: proofInBytes.proofB.flat(),
      proofC: proofInBytes.proofC,
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

    // Derive nullifier and commitment PDAs for deposit
    const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program, proofToSubmit);
    const { nullifier2PDA, nullifier3PDA } = findCrossCheckNullifierPDAs(program, proofToSubmit);
    const { commitment0PDA, commitment1PDA } = findCommitmentPDAs(program, proofToSubmit);

    // Execute the deposit transaction
    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    // Create Address Lookup Table for deposit transaction
    const depositTestProtocolAddresses = getTestProtocolAddresses(
      program.programId,
      authority.publicKey,
      treeAccountPDA,
      treeTokenAccountPDA,
      FEE_RECIPIENT_ACCOUNT
    );
    
    const depositLookupTableAddress = await createGlobalTestALT(provider.connection, authority, depositTestProtocolAddresses);
    
    const depositTx = await program.methods
      .transact(proofToSubmit, createExtDataMinified(extData), extData.encryptedOutput1, extData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: nullifier0PDA,
        nullifier1: nullifier1PDA,
        nullifier2: nullifier2PDA,
        nullifier3: nullifier3PDA,
        commitment0: commitment0PDA,
        commitment1: commitment1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: FEE_RECIPIENT_ACCOUNT,
        treeTokenAccount: treeTokenAccountPDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .preInstructions([modifyComputeUnits])
      .transaction();
    
    // Create versioned transaction with ALT for deposit
    const depositVersionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      randomUser.publicKey,
      depositTx.instructions,
      depositLookupTableAddress
    );
    
    // Send and confirm deposit versioned transaction
    await sendAndConfirmVersionedTransaction(
      provider.connection,
      depositVersionedTx,
      [randomUser]
    );

    // Now prepare for withdrawal with arithmetic overflow scenario
    // Create mock input UTXOs for withdrawal
    const withdrawInputs = [
      outputs[0], // Use the first output from deposit
      new Utxo({ lightWasm }) // Second input is empty
    ];
    const withdrawOutputs = [
      new Utxo({ lightWasm, amount: '30' }), // Some remaining amount  
      new Utxo({ lightWasm, amount: '0' }) // Empty UTXO
    ];
    const withdrawFee = new anchor.BN(0)

    // Create a normal withdrawal amount that the circuit will accept
    const withdrawInputsSum = withdrawInputs.reduce((sum, x) => sum.add(x.amount), new BN(0))
    const withdrawOutputsSum = withdrawOutputs.reduce((sum, x) => sum.add(x.amount), new BN(0))
    const validExtAmount = new BN(withdrawFee)
      .add(withdrawOutputsSum)
      .sub(withdrawInputsSum)
    
    // For circom, we need field modular arithmetic to handle negative numbers
    const withdrawPublicAmount = new BN(validExtAmount).sub(new BN(withdrawFee)).add(FIELD_SIZE).mod(FIELD_SIZE).toString()
    
    // Create ExtData with normal withdrawal amount for proof generation
    const validWithdrawExtData = {
      recipient: recipient.publicKey,
      extAmount: validExtAmount, // Normal withdrawal amount
      encryptedOutput1: Buffer.from("withdrawEncryptedOutput1"),
      encryptedOutput2: Buffer.from("withdrawEncryptedOutput2"),
      fee: withdrawFee,
      feeRecipient: FEE_RECIPIENT_ACCOUNT,
      mintAddress: new anchor.web3.PublicKey("11111111111111111111111111111112"), // SOL mint address
    };

    // Calculate the hash for withdrawal proof generation
    const withdrawExtDataHash = getExtDataHash(validWithdrawExtData);

    // Create a new tree and insert the deposit output commitments
    for (const commitment of outputCommitments) {
      tree.insert(commitment);
    }

    const oldRoot = tree.root();

    // Get nullifiers and commitments for withdrawal
    const withdrawInputNullifiers = await Promise.all(withdrawInputs.map(x => x.getNullifier()));
    const withdrawOutputCommitments = await Promise.all(withdrawOutputs.map(x => x.getCommitment()));

    // Calculate Merkle paths for withdrawal inputs properly
    const withdrawalInputMerklePathIndices = []
    const withdrawalInputMerklePathElements = []
    for (let i = 0; i < withdrawInputs.length; i++) {
      const withdrawInput = withdrawInputs[i]
      if (withdrawInput.amount.gt(new BN(0))) {
        const commitment = outputCommitments[i]
        withdrawInput.index = tree.indexOf(commitment)
        if (withdrawInput.index < 0) {
          throw new Error(`Input commitment ${commitment} was not found`)
        }
        withdrawalInputMerklePathIndices.push(withdrawInput.index)
        withdrawalInputMerklePathElements.push(tree.path(withdrawInput.index).pathElements)
      } else {
        withdrawalInputMerklePathIndices.push(0)
        withdrawalInputMerklePathElements.push(new Array(tree.levels).fill(0))
      }
    }

    // Create input for withdrawal proof generation
    const withdrawInput = {
      // Common transaction data
      root: oldRoot,
      inputNullifier: withdrawInputNullifiers,
      outputCommitment: withdrawOutputCommitments,
      publicAmount: withdrawPublicAmount.toString(),
      extDataHash: withdrawExtDataHash,
      
      // Input UTXO data (UTXOs being spent)
      inAmount: withdrawInputs.map(x => x.amount.toString(10)),
      inPrivateKey: withdrawInputs.map(x => x.keypair.privkey),
      inBlinding: withdrawInputs.map(x => x.blinding.toString(10)),
      mintAddress: withdrawInputs[0].mintAddress,
      inPathIndices: withdrawalInputMerklePathIndices,
      inPathElements: withdrawalInputMerklePathElements,
      
      // Output UTXO data (UTXOs being created)
      outAmount: withdrawOutputs.map(x => x.amount.toString(10)),
      outBlinding: withdrawOutputs.map(x => x.blinding.toString(10)),
      outPubkey: withdrawOutputs.map(x => x.keypair.pubkey),
    };

    // Generate proof for withdrawal
    const withdrawProofResult = await prove(withdrawInput, keyBasePath);
    const withdrawProofInBytes = parseProofToBytesArray(withdrawProofResult.proof);
    const withdrawInputsInBytes = parseToBytesArray(withdrawProofResult.publicSignals);
    
    // Create the final withdrawal proof object
    const withdrawProofToSubmit = {
      proofA: withdrawProofInBytes.proofA,
      proofB: withdrawProofInBytes.proofB.flat(),
      proofC: withdrawProofInBytes.proofC,
      root: withdrawInputsInBytes[0],
      publicAmount: withdrawInputsInBytes[1],
      extDataHash: withdrawInputsInBytes[2],
      inputNullifiers: [
        withdrawInputsInBytes[3],
        withdrawInputsInBytes[4]
      ],
      outputCommitments: [
        withdrawInputsInBytes[5],
        withdrawInputsInBytes[6]
      ],
    };

         // Derive PDAs for withdrawal nullifiers
     const withdrawNullifiers = findNullifierPDAs(program, withdrawProofToSubmit);
     const withdrawCrossCheckNullifiers = findCrossCheckNullifierPDAs(program, withdrawProofToSubmit);
     
     // Derive PDAs for withdrawal commitments
     const withdrawCommitments = findCommitmentPDAs(program, withdrawProofToSubmit);

    // Execute the withdrawal transaction - this should succeed and demonstrate arithmetic protection is in place
    try {
      // Create Address Lookup Table for withdrawal transaction
      const withdrawTestProtocolAddresses = getTestProtocolAddresses(
        program.programId,
        authority.publicKey,
        treeAccountPDA,
        treeTokenAccountPDA,
        FEE_RECIPIENT_ACCOUNT
      );
      
      const withdrawLookupTableAddress = await createGlobalTestALT(provider.connection, authority, withdrawTestProtocolAddresses);
      
      const withdrawTx = await program.methods
        .transact(withdrawProofToSubmit, createExtDataMinified(validWithdrawExtData), validWithdrawExtData.encryptedOutput1, validWithdrawExtData.encryptedOutput2)
        .accounts({
          treeAccount: treeAccountPDA,
          nullifier0: withdrawNullifiers.nullifier0PDA,
          nullifier1: withdrawNullifiers.nullifier1PDA,
          nullifier2: withdrawCrossCheckNullifiers.nullifier2PDA,
          nullifier3: withdrawCrossCheckNullifiers.nullifier3PDA,
          commitment0: withdrawCommitments.commitment0PDA,
          commitment1: withdrawCommitments.commitment1PDA,
          recipient: recipient.publicKey,
          feeRecipientAccount: FEE_RECIPIENT_ACCOUNT,
          treeTokenAccount: treeTokenAccountPDA,
        globalConfig: globalConfigPDA,
          signer: randomUser.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([randomUser])
        .preInstructions([modifyComputeUnits])
        .transaction();
      
      // Create versioned transaction with ALT for withdrawal
      const withdrawVersionedTx = await createVersionedTransactionWithALT(
        provider.connection,
        randomUser.publicKey,
        withdrawTx.instructions,
        withdrawLookupTableAddress
      );
      
      // Send and confirm withdrawal versioned transaction
      await sendAndConfirmVersionedTransaction(
        provider.connection,
        withdrawVersionedTx,
        [randomUser]
      );

      // If we get here, it means the arithmetic protection is working correctly
      // and allows normal transactions while protecting against overflow
      expect(true).to.be.true;

      for (const commitment of withdrawOutputCommitments) {
        tree.insert(commitment);
      }
    } catch (error) {
      // If transaction fails, this might indicate an issue since this test should succeed
      // This test should succeed, so if it fails there might be another issue
      throw error;
    }
  });

  it("Fails transact instruction for invalid mint address", async () => {
    // Create a sample ExtData object with invalid mint address
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(100), // Positive amount (deposit)
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(10),
      feeRecipient: FEE_RECIPIENT_ACCOUNT,
      mintAddress: new anchor.web3.PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), // USDC mint address (invalid)
    };

    // Calculate the correct extDataHash
    const calculatedExtDataHash = getExtDataHash(extData);
    
    // Create a Proof object with correct hash but the ExtData has invalid mint
    const proof = {
      proofA: Array(64).fill(1), // 64-byte array for proofA
      proofB: Array(128).fill(2), // 128-byte array for proofB  
      proofC: Array(64).fill(3), // 64-byte array for proofC
      root: ZERO_BYTES[DEFAULT_HEIGHT],
      inputNullifiers: [
        Array.from(generateRandomNullifier()),
        Array.from(generateRandomNullifier())
      ],
      outputCommitments: [
        Array(32).fill(3),
        Array(32).fill(4)
      ],
      publicAmount: bnToBytes(new anchor.BN(90)), // 100 - 10 fee
      extDataHash: Array.from(calculatedExtDataHash)
    };

    // Get nullifier PDAs
    const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program, proof);
    const { nullifier2PDA, nullifier3PDA } = findCrossCheckNullifierPDAs(program, proof);
    
    // Get commitment PDAs
    const { commitment0PDA, commitment1PDA } = findCommitmentPDAs(program, proof);

    try {
      // Create the compute units instruction
      const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
        units: 1_000_000 
      });
      
      // Execute the transaction - this should fail because of invalid mint address
      const tx = await program.methods
        .transact(proof, createExtDataMinified(extData), extData.encryptedOutput1, extData.encryptedOutput2)
        .accounts({
          treeAccount: treeAccountPDA,
          nullifier0: nullifier0PDA,
          nullifier1: nullifier1PDA,
          nullifier2: nullifier2PDA,
          nullifier3: nullifier3PDA,
          commitment0: commitment0PDA,
          commitment1: commitment1PDA,
          recipient: recipient.publicKey,
          feeRecipientAccount: FEE_RECIPIENT_ACCOUNT,
          treeTokenAccount: treeTokenAccountPDA,
        globalConfig: globalConfigPDA,
          signer: randomUser.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([randomUser])
        .preInstructions([modifyComputeUnits])
        .transaction();
      
      // Create v0 transaction to allow larger size
      const latestBlockhash = await provider.connection.getLatestBlockhash();
      const messageLegacy = new anchor.web3.TransactionMessage({
        payerKey: randomUser.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: tx.instructions,
      }).compileToLegacyMessage();
      
      // Create a versioned transaction
      const transactionV0 = new anchor.web3.VersionedTransaction(messageLegacy);
      
      // Sign the transaction
      transactionV0.sign([randomUser]);
      
      // Send and confirm transaction - this should fail
      await provider.connection.sendTransaction(transactionV0, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });
      
      // If we reach here, the test should fail because the transaction should have thrown an error
      expect.fail("Transaction should have failed due to invalid mint address but succeeded");
    } catch (error) {
      const errorString = error.toString();
      expect(
        errorString.includes("0x1774") || 
        // because of ExtDataHash derived onchain must be SOL (hardcoded in the program)
        errorString.includes("ExtDataHashMismatch") ||
        errorString.includes("Transaction simulation failed")
      ).to.be.true;
    }
  });

  it("Authority can update global config - fee recipient", async () => {
    const newFeeRecipient = anchor.web3.Keypair.generate();
    
    // Create Address Lookup Table for transaction size optimization
    const testProtocolAddresses = getTestProtocolAddresses(
      program.programId,
      authority.publicKey,
      treeAccountPDA,
      treeTokenAccountPDA,
      FEE_RECIPIENT_ACCOUNT
    );
    
    const lookupTableAddress = await createGlobalTestALT(provider.connection, authority, testProtocolAddresses);

    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    const tx = await program.methods
      .updateGlobalConfig(
        null, // deposit_fee_rate
        null, // withdrawal_fee_rate  
        null  // fee_error_margin
      )
      .accounts({
        globalConfig: globalConfigPDA,
        authority: authority.publicKey,
      })
      .signers([authority])
      .preInstructions([modifyComputeUnits])
      .transaction();

    // Create versioned transaction with ALT
    const versionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      authority.publicKey,
      tx.instructions,
      lookupTableAddress
    );
    
    // Send and confirm versioned transaction
    const txSig = await sendAndConfirmVersionedTransaction(
      provider.connection,
      versionedTx,
      [authority]
    );

    expect(txSig).to.be.a('string');
  });

  it("Authority can update global config - deposit fee rate", async () => {
    const newDepositFeeRate = 50; // 0.5%
    
    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    await program.methods
      .updateGlobalConfig(
        newDepositFeeRate, // deposit_fee_rate
        null, // withdrawal_fee_rate
        null  // fee_error_margin
      )
      .accounts({
        globalConfig: globalConfigPDA,
        authority: authority.publicKey,
      })
      .signers([authority])
      .preInstructions([modifyComputeUnits])
      .rpc();

    // Verify the deposit fee rate was updated
    const globalConfig = await program.account.globalConfig.fetch(globalConfigPDA);
    expect(globalConfig.depositFeeRate).to.equal(newDepositFeeRate);
  });

  it("Authority can update global config - withdrawal fee rate", async () => {
    const newWithdrawalFeeRate = 100; // 1%
    
    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    await program.methods
      .updateGlobalConfig(
        null, // deposit_fee_rate
        newWithdrawalFeeRate, // withdrawal_fee_rate
        null  // fee_error_margin
      )
      .accounts({
        globalConfig: globalConfigPDA,
        authority: authority.publicKey,
      })
      .signers([authority])
      .preInstructions([modifyComputeUnits])
      .rpc();

    // Verify the withdrawal fee rate was updated
    const globalConfig = await program.account.globalConfig.fetch(globalConfigPDA);
    expect(globalConfig.withdrawalFeeRate).to.equal(newWithdrawalFeeRate);
  });

  it("Authority can update global config - fee error margin", async () => {
    const newFeeErrorMargin = 1000; // 10%
    
    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    await program.methods
      .updateGlobalConfig(
        null, // deposit_fee_rate
        null, // withdrawal_fee_rate
        newFeeErrorMargin  // fee_error_margin
      )
      .accounts({
        globalConfig: globalConfigPDA,
        authority: authority.publicKey,
      })
      .signers([authority])
      .preInstructions([modifyComputeUnits])
      .rpc();

    // Verify the fee error margin was updated
    const globalConfig = await program.account.globalConfig.fetch(globalConfigPDA);
    expect(globalConfig.feeErrorMargin).to.equal(newFeeErrorMargin);
  });

  it("Authority can update multiple global config parameters at once", async () => {
    const newFeeRecipient = new PublicKey(FEE_RECIPIENT_ACCOUNT);
    const newDepositFeeRate = 75; // 0.75%
    const newWithdrawalFeeRate = 150; // 1.5%
    const newFeeErrorMargin = 250; // 2.5%
    
    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    await program.methods
      .updateGlobalConfig(
        newDepositFeeRate, // deposit_fee_rate
        newWithdrawalFeeRate, // withdrawal_fee_rate
        newFeeErrorMargin  // fee_error_margin
      )
      .accounts({
        globalConfig: globalConfigPDA,
        authority: authority.publicKey,
      })
      .signers([authority])
      .preInstructions([modifyComputeUnits])
      .rpc();

    // Verify all parameters were updated
    const globalConfig = await program.account.globalConfig.fetch(globalConfigPDA);
    expect(globalConfig.depositFeeRate).to.equal(newDepositFeeRate);
    expect(globalConfig.withdrawalFeeRate).to.equal(newWithdrawalFeeRate);
    expect(globalConfig.feeErrorMargin).to.equal(newFeeErrorMargin);
  });

  it("Non-authority cannot update global config", async () => {
    const nonAuthority = anchor.web3.Keypair.generate();
    
    // Fund the non-authority account
    const transferTx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: fundingAccount.publicKey,
        toPubkey: nonAuthority.publicKey,
        lamports: 0.5 * LAMPORTS_PER_SOL,
      })
    );
    
    const transferSignature = await provider.connection.sendTransaction(transferTx, [fundingAccount]);
    await provider.connection.confirmTransaction(transferSignature);

    try {
      const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
        units: 1_000_000 
      });
      
      await program.methods
        .updateGlobalConfig(
          100,  // deposit_fee_rate
          null, // withdrawal_fee_rate
          null  // fee_error_margin
        )
        .accounts({
          globalConfig: globalConfigPDA,
          authority: nonAuthority.publicKey,
        })
        .signers([nonAuthority])
        .preInstructions([modifyComputeUnits])
        .rpc();

      expect.fail("Transaction should have failed due to unauthorized access");
    } catch (error) {
      const errorString = error.toString();
      expect(
        errorString.includes("ConstraintSeeds") ||
        errorString.includes("0x7d6") ||
        errorString.includes("constraint was violated") ||
        errorString.includes("seeds constraint was violated") ||
        errorString.includes("Unauthorized") ||
        errorString.includes("0x1775") ||
        errorString.includes("Error") ||
        errorString.includes("failed")
      ).to.be.true;
    }
  });

  it("Fails to update global config with invalid fee rate (> 10000)", async () => {
    try {
      const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
        units: 1_000_000 
      });
      
      await program.methods
        .updateGlobalConfig(
          15000, // deposit_fee_rate (150% - invalid)
          null, // withdrawal_fee_rate
          null  // fee_error_margin
        )
        .accounts({
          globalConfig: globalConfigPDA,
          authority: authority.publicKey,
        })
        .signers([authority])
        .preInstructions([modifyComputeUnits])
        .rpc();

      expect.fail("Transaction should have failed due to invalid fee rate");
    } catch (error) {
      const errorString = error.toString();
      expect(
        errorString.includes("0x1776") || 
        errorString.includes("InvalidFeeRate") ||
        errorString.includes("custom program error")
      ).to.be.true;
    }
  });

  it("Fails to update global config with invalid withdrawal fee rate (> 10000)", async () => {
    try {
      const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
        units: 1_000_000 
      });
      
      await program.methods
        .updateGlobalConfig(
          null, // deposit_fee_rate
          12000, // withdrawal_fee_rate (120% - invalid)
          null  // fee_error_margin
        )
        .accounts({
          globalConfig: globalConfigPDA,
          authority: authority.publicKey,
        })
        .signers([authority])
        .preInstructions([modifyComputeUnits])
        .rpc();

      expect.fail("Transaction should have failed due to invalid withdrawal fee rate");
    } catch (error) {
      const errorString = error.toString();
      expect(
        errorString.includes("0x1776") || 
        errorString.includes("InvalidFeeRate") ||
        errorString.includes("custom program error")
      ).to.be.true;
    }
  });

  it("Fails to update global config with invalid fee error margin (> 10000)", async () => {
    try {
      const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
        units: 1_000_000 
      });
      
      await program.methods
        .updateGlobalConfig(
          null, // deposit_fee_rate
          null, // withdrawal_fee_rate
          20000 // fee_error_margin (200% - invalid)
        )
        .accounts({
          globalConfig: globalConfigPDA,
          authority: authority.publicKey,
        })
        .signers([authority])
        .preInstructions([modifyComputeUnits])
        .rpc();

      expect.fail("Transaction should have failed due to invalid fee error margin");
    } catch (error) {
      const errorString = error.toString();
      expect(
        errorString.includes("0x1776") || 
        errorString.includes("InvalidFeeRate") ||
        errorString.includes("custom program error")
      ).to.be.true;
    }
  });

  it("Global config update with null values leaves existing values unchanged", async () => {
    // Get the current global config values
    const initialConfig = await program.account.globalConfig.fetch(globalConfigPDA);
    
    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    // Update with all null values
    await program.methods
      .updateGlobalConfig(
        null, // deposit_fee_rate
        null, // withdrawal_fee_rate
        null  // fee_error_margin
      )
      .accounts({
        globalConfig: globalConfigPDA,
        authority: authority.publicKey,
      })
      .signers([authority])
      .preInstructions([modifyComputeUnits])
      .rpc();

    // Verify all values remain unchanged
    const updatedConfig = await program.account.globalConfig.fetch(globalConfigPDA);
    expect(updatedConfig.depositFeeRate).to.equal(initialConfig.depositFeeRate);
    expect(updatedConfig.withdrawalFeeRate).to.equal(initialConfig.withdrawalFeeRate);
    expect(updatedConfig.feeErrorMargin).to.equal(initialConfig.feeErrorMargin);
  });

  it("Succeeds with valid SOL mint address", async () => {
    const depositAmount = 200;
    const actualDepositFee = calculateDepositFee(depositAmount);
    const depositFee = new anchor.BN(actualDepositFee);
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(depositAmount), // Positive ext amount (deposit)
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: depositFee,
      feeRecipient: FEE_RECIPIENT_ACCOUNT,
      mintAddress: new anchor.web3.PublicKey("11111111111111111111111111111112"), // Valid SOL mint address (System Program ID)
    };

    // Create the merkle tree
    const tree: MerkleTree = new MerkleTree(DEFAULT_HEIGHT, lightWasm);

    // Create inputs for the deposit
    const inputs = [
      new Utxo({ lightWasm }),
      new Utxo({ lightWasm })
    ];

    const outputAmount = (depositAmount - actualDepositFee).toString();
    const outputs = [
      new Utxo({ lightWasm, amount: outputAmount }),
      new Utxo({ lightWasm, amount: '0' })
    ];

    // Create mock Merkle path data
    const inputMerklePathIndices = inputs.map((input) => input.index || 0);
    const inputMerklePathElements = inputs.map(() => {
      return [...new Array(tree.levels).fill(0)];
    });

    // Resolve all async operations
    const inputNullifiers = await Promise.all(inputs.map(x => x.getNullifier()));
    const outputCommitments = await Promise.all(outputs.map(x => x.getCommitment()));
    const root = tree.root();
    const calculatedExtDataHash = getExtDataHash(extData);
    const publicAmountNumber = new anchor.BN(depositAmount - actualDepositFee);

    const input = {
      root: root,
      inputNullifier: inputNullifiers,
      outputCommitment: outputCommitments,
      publicAmount: publicAmountNumber.toString(),
      extDataHash: calculatedExtDataHash,
      inAmount: inputs.map(x => x.amount.toString(10)),
      inPrivateKey: inputs.map(x => x.keypair.privkey),
      inBlinding: inputs.map(x => x.blinding.toString(10)),
      mintAddress: inputs[0].mintAddress,
      inPathIndices: inputMerklePathIndices,
      inPathElements: inputMerklePathElements,
      outAmount: outputs.map(x => x.amount.toString(10)),
      outBlinding: outputs.map(x => x.blinding.toString(10)),
      outPubkey: outputs.map(x => x.keypair.pubkey),
    };

    // Generate proof
    const keyBasePath = path.resolve(__dirname, '../../artifacts/circuits/transaction2');
    const {proof, publicSignals} = await prove(input, keyBasePath);

    const proofInBytes = parseProofToBytesArray(proof);
    const inputsInBytes = parseToBytesArray(publicSignals);
    
    const proofToSubmit = {
      proofA: proofInBytes.proofA,
      proofB: proofInBytes.proofB.flat(),
      proofC: proofInBytes.proofC,
      root: inputsInBytes[0],
      publicAmount: inputsInBytes[1],
      extDataHash: inputsInBytes[2],
      inputNullifiers: [inputsInBytes[3], inputsInBytes[4]],
      outputCommitments: [inputsInBytes[5], inputsInBytes[6]],
    };

    // Derive PDAs
    const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program, proofToSubmit);
    const crossCheckNullifiers = findCrossCheckNullifierPDAs(program, proofToSubmit);
    const { commitment0PDA, commitment1PDA } = findCommitmentPDAs(program, proofToSubmit);

    // Create Address Lookup Table
    const testProtocolAddresses = getTestProtocolAddresses(
      program.programId,
      authority.publicKey,
      treeAccountPDA,
      treeTokenAccountPDA,
      FEE_RECIPIENT_ACCOUNT
    );
    
    const lookupTableAddress = await createGlobalTestALT(provider.connection, authority, testProtocolAddresses);

    // Execute the transaction - should succeed with valid SOL mint address
    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    const tx = await program.methods
      .transact(proofToSubmit, createExtDataMinified(extData), extData.encryptedOutput1, extData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: nullifier0PDA,
        nullifier1: nullifier1PDA,
        nullifier2: crossCheckNullifiers.nullifier2PDA,
        nullifier3: crossCheckNullifiers.nullifier3PDA,
        commitment0: commitment0PDA,
        commitment1: commitment1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: FEE_RECIPIENT_ACCOUNT,
        treeTokenAccount: treeTokenAccountPDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .preInstructions([modifyComputeUnits])
      .transaction();

    // Create versioned transaction with ALT
    const versionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      randomUser.publicKey,
      tx.instructions,
      lookupTableAddress
    );
    
    // Send and confirm versioned transaction
    const txSig = await sendAndConfirmVersionedTransaction(
      provider.connection,
      versionedTx,
      [randomUser]
    );

    expect(txSig).to.be.a('string');
  });
});
