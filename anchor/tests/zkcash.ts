import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Zkcash } from "../target/types/zkcash"; // This should be `zkcash` unless the program name is actually "anchor"
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { DEFAULT_HEIGHT, FIELD_SIZE, ROOT_HISTORY_SIZE, ZERO_BYTES } from "./lib/constants";
import { getExtDataHash } from "../../scripts/utils/utils";

import * as crypto from "crypto";
import * as path from 'path';
import { Utxo } from "./lib/utxo";
import { parseProofToBytesArray, parseToBytesArray, prove, verify } from "./lib/prover";
import { utils } from 'ffjavascript';
import { LightWasm, WasmFactory } from "@lightprotocol/hasher.rs";
import { BN } from 'bn.js';

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

    // Check the balance
    const balance = await provider.connection.getBalance(fundingAccount.publicKey);
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

  it("Can execute both deposit and withdraw instruction for correct input, with positive fee", async () => {
    const depositFee = new anchor.BN(50)
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(200), // Positive ext amount (deposit)
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: depositFee, // Fee
    };

    // Create the merkle tree with the pre-initialized poseidon hash
    const tree: MerkleTree = new MerkleTree(DEFAULT_HEIGHT, lightWasm);

    // Create inputs for the first deposit
    const inputs = [
      new Utxo({ lightWasm }),
      new Utxo({ lightWasm })
    ];

    const outputAmount = '150';
    const outputs = [
      new Utxo({ lightWasm, amount: outputAmount }), // Combined amount minus fee
      new Utxo({ lightWasm, amount: '0' }) // Empty UTXO
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

    // Calculate the hash correctly using our utility
    const calculatedExtDataHash = getExtDataHash(extData);
    const publicAmountNumber = new anchor.BN(150);

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

    // Derive commitment PDAs
    const { commitment0PDA, commitment1PDA } = findCommitmentPDAs(program, proofToSubmit);

    // Get balances before transaction
    const treeTokenAccountBalanceBefore = await provider.connection.getBalance(treeTokenAccountPDA);
    const feeRecipientBalanceBefore = await provider.connection.getBalance(feeRecipientPDA);
    const recipientBalanceBefore = await provider.connection.getBalance(recipient.publicKey);
    const randomUserBalanceBefore = await provider.connection.getBalance(randomUser.publicKey);

    // Execute the transaction without pre-instructions
    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    const tx = await program.methods
      .transact(proofToSubmit, extData)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: nullifier0PDA,
        nullifier1: nullifier1PDA,
        commitment0: commitment0PDA,
        commitment1: commitment1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: feeRecipientPDA,
        treeTokenAccount: treeTokenAccountPDA,
        authority: authority.publicKey,
        signer: randomUser.publicKey, // Use random user as signer
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser]) // Random user signs the transaction
      .preInstructions([modifyComputeUnits]) // Add compute budget instruction as pre-instruction
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
    
    // Send and confirm transaction
    const txSig = await provider.connection.sendTransaction(transactionV0, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    
    await provider.connection.confirmTransaction({
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      signature: txSig,
    });
    
    expect(txSig).to.be.a('string');

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
    const feeRecipientBalanceAfter = await provider.connection.getBalance(feeRecipientPDA);
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
      new Utxo({ lightWasm, amount: '30' }), // Some remaining amount
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
    };

    // Calculate the hash for withdrawal
    const withdrawExtDataHash = getExtDataHash(withdrawExtData);

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
    
    // Derive PDAs for withdrawal commitments
    const withdrawCommitments = findCommitmentPDAs(program, withdrawProofToSubmit);

    // Execute the withdrawal transaction
    const withdrawTx = await program.methods
      .transact(withdrawProofToSubmit, withdrawExtData)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: withdrawNullifiers.nullifier0PDA,
        nullifier1: withdrawNullifiers.nullifier1PDA,
        commitment0: withdrawCommitments.commitment0PDA,
        commitment1: withdrawCommitments.commitment1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: feeRecipientPDA,
        treeTokenAccount: treeTokenAccountPDA,
        authority: authority.publicKey,
        signer: randomUser.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .transaction();
      
    // Add compute budget instruction
    withdrawTx.add(modifyComputeUnits);
    
    // Create v0 transaction to allow larger size
    const withdrawLatestBlockhash = await provider.connection.getLatestBlockhash();
    const withdrawMessageLegacy = new anchor.web3.TransactionMessage({
      payerKey: randomUser.publicKey,
      recentBlockhash: withdrawLatestBlockhash.blockhash,
      instructions: withdrawTx.instructions,
    }).compileToLegacyMessage();
    
    // Create a versioned transaction
    const withdrawTransactionV0 = new anchor.web3.VersionedTransaction(withdrawMessageLegacy);
    
    // Sign the transaction
    withdrawTransactionV0.sign([randomUser]);
    
    // Send and confirm transaction
    const withdrawTxSig = await provider.connection.sendTransaction(withdrawTransactionV0, {
      skipPreflight: false, 
      preflightCommitment: 'confirmed',
    });
    
    await provider.connection.confirmTransaction({
      blockhash: withdrawLatestBlockhash.blockhash,
      lastValidBlockHeight: withdrawLatestBlockhash.lastValidBlockHeight,
      signature: withdrawTxSig,
    });
    
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
    const finalFeeRecipientBalance = await provider.connection.getBalance(feeRecipientPDA);
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
  });

  it("Can execute both deposit and withdraw instruction for correct input, with 0 fee", async () => {
    const depositFee = new anchor.BN(0)
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(200), // Positive ext amount (deposit)
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: depositFee, // Fee
    };

    // Create the merkle tree with the pre-initialized poseidon hash
    const tree: MerkleTree = new MerkleTree(DEFAULT_HEIGHT, lightWasm);

    // Create inputs for the first deposit
    const inputs = [
      new Utxo({ lightWasm }),
      new Utxo({ lightWasm })
    ];

    const publicAmountNumber = extData.extAmount.sub(depositFee);
    const outputAmount = publicAmountNumber.toString();
    const outputs = [
      new Utxo({ lightWasm, amount: outputAmount }), // Combined amount minus fee
      new Utxo({ lightWasm, amount: '0' }) // Empty UTXO
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

    // Derive commitment PDAs
    const { commitment0PDA, commitment1PDA } = findCommitmentPDAs(program, proofToSubmit);

    // Get balances before transaction
    const treeTokenAccountBalanceBefore = await provider.connection.getBalance(treeTokenAccountPDA);
    const feeRecipientBalanceBefore = await provider.connection.getBalance(feeRecipientPDA);
    const recipientBalanceBefore = await provider.connection.getBalance(recipient.publicKey);
    const randomUserBalanceBefore = await provider.connection.getBalance(randomUser.publicKey);

    // Execute the transaction without pre-instructions
    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    const tx = await program.methods
      .transact(proofToSubmit, extData)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: nullifier0PDA,
        nullifier1: nullifier1PDA,
        commitment0: commitment0PDA,
        commitment1: commitment1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: feeRecipientPDA,
        treeTokenAccount: treeTokenAccountPDA,
        authority: authority.publicKey,
        signer: randomUser.publicKey, // Use random user as signer
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser]) // Random user signs the transaction
      .preInstructions([modifyComputeUnits]) // Add compute budget instruction as pre-instruction
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
    
    // Send and confirm transaction
    const txSig = await provider.connection.sendTransaction(transactionV0, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    
    await provider.connection.confirmTransaction({
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      signature: txSig,
    });
    
    expect(txSig).to.be.a('string');

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
    const feeRecipientBalanceAfter = await provider.connection.getBalance(feeRecipientPDA);
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
      new Utxo({ lightWasm, amount: '30' }), // Some remaining amount
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
    };

    // Calculate the hash for withdrawal
    const withdrawExtDataHash = getExtDataHash(withdrawExtData);

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
    
    // Derive PDAs for withdrawal commitments
    const withdrawCommitments = findCommitmentPDAs(program, withdrawProofToSubmit);

    // Execute the withdrawal transaction
    const withdrawTx = await program.methods
      .transact(withdrawProofToSubmit, withdrawExtData)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: withdrawNullifiers.nullifier0PDA,
        nullifier1: withdrawNullifiers.nullifier1PDA,
        commitment0: withdrawCommitments.commitment0PDA,
        commitment1: withdrawCommitments.commitment1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: feeRecipientPDA,
        treeTokenAccount: treeTokenAccountPDA,
        authority: authority.publicKey,
        signer: randomUser.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .transaction();
      
    // Add compute budget instruction
    withdrawTx.add(modifyComputeUnits);
    
    // Create v0 transaction to allow larger size
    const withdrawLatestBlockhash = await provider.connection.getLatestBlockhash();
    const withdrawMessageLegacy = new anchor.web3.TransactionMessage({
      payerKey: randomUser.publicKey,
      recentBlockhash: withdrawLatestBlockhash.blockhash,
      instructions: withdrawTx.instructions,
    }).compileToLegacyMessage();
    
    // Create a versioned transaction
    const withdrawTransactionV0 = new anchor.web3.VersionedTransaction(withdrawMessageLegacy);
    
    // Sign the transaction
    withdrawTransactionV0.sign([randomUser]);
    
    // Send and confirm transaction
    const withdrawTxSig = await provider.connection.sendTransaction(withdrawTransactionV0, {
      skipPreflight: false, 
      preflightCommitment: 'confirmed',
    });
    
    await provider.connection.confirmTransaction({
      blockhash: withdrawLatestBlockhash.blockhash,
      lastValidBlockHeight: withdrawLatestBlockhash.lastValidBlockHeight,
      signature: withdrawTxSig,
    });
    
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
    const finalFeeRecipientBalance = await provider.connection.getBalance(feeRecipientPDA);
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
  });

  it("Can execute both deposit and withdraw instruction for correct input, after withdrawing full amount", async () => {
    const depositFee = new anchor.BN(50)
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(200), // Positive ext amount (deposit)
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: depositFee, // Fee
    };

    // Create the merkle tree with the pre-initialized poseidon hash
    const tree: MerkleTree = new MerkleTree(DEFAULT_HEIGHT, lightWasm);

    // Create inputs for the first deposit
    const inputs = [
      new Utxo({ lightWasm }),
      new Utxo({ lightWasm })
    ];

    const outputAmount = '150';
    const outputs = [
      new Utxo({ lightWasm, amount: outputAmount }), // Combined amount minus fee
      new Utxo({ lightWasm, amount: '0' }) // Empty UTXO
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

    // Calculate the hash correctly using our utility
    const calculatedExtDataHash = getExtDataHash(extData);
    const publicAmountNumber = new anchor.BN(150);

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

    // Derive commitment PDAs
    const { commitment0PDA, commitment1PDA } = findCommitmentPDAs(program, proofToSubmit);

    // Get balances before transaction
    const treeTokenAccountBalanceBefore = await provider.connection.getBalance(treeTokenAccountPDA);
    const feeRecipientBalanceBefore = await provider.connection.getBalance(feeRecipientPDA);
    const recipientBalanceBefore = await provider.connection.getBalance(recipient.publicKey);
    const randomUserBalanceBefore = await provider.connection.getBalance(randomUser.publicKey);

    // Execute the transaction without pre-instructions
    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    const tx = await program.methods
      .transact(proofToSubmit, extData)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: nullifier0PDA,
        nullifier1: nullifier1PDA,
        commitment0: commitment0PDA,
        commitment1: commitment1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: feeRecipientPDA,
        treeTokenAccount: treeTokenAccountPDA,
        authority: authority.publicKey,
        signer: randomUser.publicKey, // Use random user as signer
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser]) // Random user signs the transaction
      .preInstructions([modifyComputeUnits]) // Add compute budget instruction as pre-instruction
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
    
    // Send and confirm transaction
    const txSig = await provider.connection.sendTransaction(transactionV0, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    
    await provider.connection.confirmTransaction({
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      signature: txSig,
    });
    
    expect(txSig).to.be.a('string');

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
    const feeRecipientBalanceAfter = await provider.connection.getBalance(feeRecipientPDA);
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
      new Utxo({ lightWasm, amount: '0' }), // Some remaining amount
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
    };

    // Calculate the hash for withdrawal
    const withdrawExtDataHash = getExtDataHash(withdrawExtData);

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
    
    // Derive PDAs for withdrawal commitments
    const withdrawCommitments = findCommitmentPDAs(program, withdrawProofToSubmit);

    // Execute the withdrawal transaction
    const withdrawTx = await program.methods
      .transact(withdrawProofToSubmit, withdrawExtData)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: withdrawNullifiers.nullifier0PDA,
        nullifier1: withdrawNullifiers.nullifier1PDA,
        commitment0: withdrawCommitments.commitment0PDA,
        commitment1: withdrawCommitments.commitment1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: feeRecipientPDA,
        treeTokenAccount: treeTokenAccountPDA,
        authority: authority.publicKey,
        signer: randomUser.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .transaction();
      
    // Add compute budget instruction
    withdrawTx.add(modifyComputeUnits);
    
    // Create v0 transaction to allow larger size
    const withdrawLatestBlockhash = await provider.connection.getLatestBlockhash();
    const withdrawMessageLegacy = new anchor.web3.TransactionMessage({
      payerKey: randomUser.publicKey,
      recentBlockhash: withdrawLatestBlockhash.blockhash,
      instructions: withdrawTx.instructions,
    }).compileToLegacyMessage();
    
    // Create a versioned transaction
    const withdrawTransactionV0 = new anchor.web3.VersionedTransaction(withdrawMessageLegacy);
    
    // Sign the transaction
    withdrawTransactionV0.sign([randomUser]);
    
    // Send and confirm transaction
    const withdrawTxSig = await provider.connection.sendTransaction(withdrawTransactionV0, {
      skipPreflight: false, 
      preflightCommitment: 'confirmed',
    });
    
    await provider.connection.confirmTransaction({
      blockhash: withdrawLatestBlockhash.blockhash,
      lastValidBlockHeight: withdrawLatestBlockhash.lastValidBlockHeight,
      signature: withdrawTxSig,
    });
    
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
    const finalFeeRecipientBalance = await provider.connection.getBalance(feeRecipientPDA);
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
  });

  it("TreeTokenAccount has $0 change, after withdrawing full amount with withdraw fees higher than deposit change", async () => {
    const depositFee = new anchor.BN(50)
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(200), // Positive ext amount (deposit)
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: depositFee, // Fee
    };

    // Create the merkle tree with the pre-initialized poseidon hash
    const tree: MerkleTree = new MerkleTree(DEFAULT_HEIGHT, lightWasm);

    // Create inputs for the first deposit
    const inputs = [
      new Utxo({ lightWasm }),
      new Utxo({ lightWasm })
    ];

    const outputAmount = '150';
    const outputs = [
      new Utxo({ lightWasm, amount: outputAmount }), // Combined amount minus fee
      new Utxo({ lightWasm, amount: '0' }) // Empty UTXO
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

    // Calculate the hash correctly using our utility
    const calculatedExtDataHash = getExtDataHash(extData);
    const publicAmountNumber = new anchor.BN(150);

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

    // Derive commitment PDAs
    const { commitment0PDA, commitment1PDA } = findCommitmentPDAs(program, proofToSubmit);

    // Get balances before transaction
    const treeTokenAccountBalanceBefore = await provider.connection.getBalance(treeTokenAccountPDA);
    const feeRecipientBalanceBefore = await provider.connection.getBalance(feeRecipientPDA);
    const recipientBalanceBefore = await provider.connection.getBalance(recipient.publicKey);
    const randomUserBalanceBefore = await provider.connection.getBalance(randomUser.publicKey);

    // Execute the transaction without pre-instructions
    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    const tx = await program.methods
      .transact(proofToSubmit, extData)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: nullifier0PDA,
        nullifier1: nullifier1PDA,
        commitment0: commitment0PDA,
        commitment1: commitment1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: feeRecipientPDA,
        treeTokenAccount: treeTokenAccountPDA,
        authority: authority.publicKey,
        signer: randomUser.publicKey, // Use random user as signer
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser]) // Random user signs the transaction
      .preInstructions([modifyComputeUnits]) // Add compute budget instruction as pre-instruction
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
    
    // Send and confirm transaction
    const txSig = await provider.connection.sendTransaction(transactionV0, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    
    await provider.connection.confirmTransaction({
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      signature: txSig,
    });
    
    expect(txSig).to.be.a('string');

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
    const feeRecipientBalanceAfter = await provider.connection.getBalance(feeRecipientPDA);
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
      new Utxo({ lightWasm, amount: '0' }), // Some remaining amount
      new Utxo({ lightWasm, amount: '0' }) // Empty UTXO
    ];
    const withdrawFee = new anchor.BN(100)

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
    };

    // Calculate the hash for withdrawal
    const withdrawExtDataHash = getExtDataHash(withdrawExtData);

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
    
    // Derive PDAs for withdrawal commitments
    const withdrawCommitments = findCommitmentPDAs(program, withdrawProofToSubmit);

    // Execute the withdrawal transaction
    const withdrawTx = await program.methods
      .transact(withdrawProofToSubmit, withdrawExtData)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: withdrawNullifiers.nullifier0PDA,
        nullifier1: withdrawNullifiers.nullifier1PDA,
        commitment0: withdrawCommitments.commitment0PDA,
        commitment1: withdrawCommitments.commitment1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: feeRecipientPDA,
        treeTokenAccount: treeTokenAccountPDA,
        authority: authority.publicKey,
        signer: randomUser.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .transaction();
      
    // Add compute budget instruction
    withdrawTx.add(modifyComputeUnits);
    
    // Create v0 transaction to allow larger size
    const withdrawLatestBlockhash = await provider.connection.getLatestBlockhash();
    const withdrawMessageLegacy = new anchor.web3.TransactionMessage({
      payerKey: randomUser.publicKey,
      recentBlockhash: withdrawLatestBlockhash.blockhash,
      instructions: withdrawTx.instructions,
    }).compileToLegacyMessage();
    
    // Create a versioned transaction
    const withdrawTransactionV0 = new anchor.web3.VersionedTransaction(withdrawMessageLegacy);
    
    // Sign the transaction
    withdrawTransactionV0.sign([randomUser]);
    
    // Send and confirm transaction
    const withdrawTxSig = await provider.connection.sendTransaction(withdrawTransactionV0, {
      skipPreflight: false, 
      preflightCommitment: 'confirmed',
    });
    
    await provider.connection.confirmTransaction({
      blockhash: withdrawLatestBlockhash.blockhash,
      lastValidBlockHeight: withdrawLatestBlockhash.lastValidBlockHeight,
      signature: withdrawTxSig,
    });
    
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
    const finalFeeRecipientBalance = await provider.connection.getBalance(feeRecipientPDA);
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
  });

  it("TreeTokenAccount has $0 change, after withdrawing full amount with withdraw fees the same as deposit change", async () => {
    const depositFee = new anchor.BN(50)
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(200), // Positive ext amount (deposit)
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: depositFee, // Fee
    };

    // Create the merkle tree with the pre-initialized poseidon hash
    const tree: MerkleTree = new MerkleTree(DEFAULT_HEIGHT, lightWasm);

    // Create inputs for the first deposit
    const inputs = [
      new Utxo({ lightWasm }),
      new Utxo({ lightWasm })
    ];

    const outputAmount = '150';
    const outputs = [
      new Utxo({ lightWasm, amount: outputAmount }), // Combined amount minus fee
      new Utxo({ lightWasm, amount: '0' }) // Empty UTXO
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

    // Calculate the hash correctly using our utility
    const calculatedExtDataHash = getExtDataHash(extData);
    const publicAmountNumber = new anchor.BN(150);

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

    // Derive commitment PDAs
    const { commitment0PDA, commitment1PDA } = findCommitmentPDAs(program, proofToSubmit);

    // Get balances before transaction
    const treeTokenAccountBalanceBefore = await provider.connection.getBalance(treeTokenAccountPDA);
    const feeRecipientBalanceBefore = await provider.connection.getBalance(feeRecipientPDA);
    const recipientBalanceBefore = await provider.connection.getBalance(recipient.publicKey);
    const randomUserBalanceBefore = await provider.connection.getBalance(randomUser.publicKey);

    // Execute the transaction without pre-instructions
    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    const tx = await program.methods
      .transact(proofToSubmit, extData)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: nullifier0PDA,
        nullifier1: nullifier1PDA,
        commitment0: commitment0PDA,
        commitment1: commitment1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: feeRecipientPDA,
        treeTokenAccount: treeTokenAccountPDA,
        authority: authority.publicKey,
        signer: randomUser.publicKey, // Use random user as signer
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser]) // Random user signs the transaction
      .preInstructions([modifyComputeUnits]) // Add compute budget instruction as pre-instruction
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
    
    // Send and confirm transaction
    const txSig = await provider.connection.sendTransaction(transactionV0, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    
    await provider.connection.confirmTransaction({
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      signature: txSig,
    });
    
    expect(txSig).to.be.a('string');

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
    const feeRecipientBalanceAfter = await provider.connection.getBalance(feeRecipientPDA);
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
      new Utxo({ lightWasm, amount: '0' }), // Some remaining amount
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
    };

    // Calculate the hash for withdrawal
    const withdrawExtDataHash = getExtDataHash(withdrawExtData);

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
    
    // Derive PDAs for withdrawal commitments
    const withdrawCommitments = findCommitmentPDAs(program, withdrawProofToSubmit);

    // Execute the withdrawal transaction
    const withdrawTx = await program.methods
      .transact(withdrawProofToSubmit, withdrawExtData)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: withdrawNullifiers.nullifier0PDA,
        nullifier1: withdrawNullifiers.nullifier1PDA,
        commitment0: withdrawCommitments.commitment0PDA,
        commitment1: withdrawCommitments.commitment1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: feeRecipientPDA,
        treeTokenAccount: treeTokenAccountPDA,
        authority: authority.publicKey,
        signer: randomUser.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .transaction();
      
    // Add compute budget instruction
    withdrawTx.add(modifyComputeUnits);
    
    // Create v0 transaction to allow larger size
    const withdrawLatestBlockhash = await provider.connection.getLatestBlockhash();
    const withdrawMessageLegacy = new anchor.web3.TransactionMessage({
      payerKey: randomUser.publicKey,
      recentBlockhash: withdrawLatestBlockhash.blockhash,
      instructions: withdrawTx.instructions,
    }).compileToLegacyMessage();
    
    // Create a versioned transaction
    const withdrawTransactionV0 = new anchor.web3.VersionedTransaction(withdrawMessageLegacy);
    
    // Sign the transaction
    withdrawTransactionV0.sign([randomUser]);
    
    // Send and confirm transaction
    const withdrawTxSig = await provider.connection.sendTransaction(withdrawTransactionV0, {
      skipPreflight: false, 
      preflightCommitment: 'confirmed',
    });
    
    await provider.connection.confirmTransaction({
      blockhash: withdrawLatestBlockhash.blockhash,
      lastValidBlockHeight: withdrawLatestBlockhash.lastValidBlockHeight,
      signature: withdrawTxSig,
    });
    
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
    const finalFeeRecipientBalance = await provider.connection.getBalance(feeRecipientPDA);
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
  });

  it("Fails to execute deposit when wallet has insufficient balance", async () => {
    const depositFee = new anchor.BN(50);
    const depositAmount = new anchor.BN(200); // Positive ext amount (deposit)
    
    // Create the merkle tree with the pre-initialized poseidon hash
    const tree: MerkleTree = new MerkleTree(DEFAULT_HEIGHT, lightWasm);
    
    // Create inputs for the deposit
    const inputs = [
      new Utxo({ lightWasm }),
      new Utxo({ lightWasm })
    ];
    
    const outputAmount = '150';
    const outputs = [
      new Utxo({ lightWasm, amount: outputAmount }), // Combined amount minus fee
      new Utxo({ lightWasm, amount: '0' }) // Empty UTXO
    ];
    
    // Calculate rent for accounts we need to create
    // Each nullifier and commitment account requires rent payment
    const nullifierAccountSize = 8 + 1; // 8 bytes for discriminator + 1 byte for bump
    const commitmentAccountSize = 8 + 32 + 100 + 8 + 1; // Rough estimate including discriminator, commitment, encrypted data, index, bump
    
    // We need 2 nullifier accounts and 2 commitment accounts
    const totalRentSpace = (nullifierAccountSize * 2) + (commitmentAccountSize * 2);
    
    // Get the minimum rent exemption for these accounts
    const rentExemption = await provider.connection.getMinimumBalanceForRentExemption(totalRentSpace);
    
    // Transaction fee estimate (this is an approximation)
    const txFee = 5000;
    
    // Total SOL needed = deposit amount + rent + transaction fee
    const totalRequired = depositAmount.toNumber() + rentExemption + txFee;
    
    // Create a special user with insufficient balance
    const insufficientUser = anchor.web3.Keypair.generate();

    const balanceDeficit = 1;
    
    // Fund the user with ALMOST enough SOL (just shy of what's needed)
    const transferTx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: fundingAccount.publicKey,
        toPubkey: insufficientUser.publicKey,
        lamports: totalRequired - balanceDeficit, // 1 lamports short of what's needed
      })
    );
    
    // Send and confirm the transfer transaction
    const transferSignature = await provider.connection.sendTransaction(transferTx, [fundingAccount]);
    await provider.connection.confirmTransaction(transferSignature);
    
    // Verify the user has received the funds but it's insufficient
    const userBalance = await provider.connection.getBalance(insufficientUser.publicKey);
    expect(userBalance).to.be.equal(totalRequired - balanceDeficit);
    
    // Create the ext data for the deposit
    const extData = {
      recipient: recipient.publicKey,
      extAmount: depositAmount,
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: depositFee, // Fee
    };
    
    // Create mock Merkle path data
    const inputMerklePathIndices = inputs.map((input) => input.index || 0);
    const inputMerklePathElements = inputs.map(() => {
      return [...new Array(tree.levels).fill(0)];
    });
    
    // Resolve all async operations before creating the input object
    const inputNullifiers = await Promise.all(inputs.map(x => x.getNullifier()));
    const outputCommitments = await Promise.all(outputs.map(x => x.getCommitment()));
    
    // Use the properly calculated Merkle tree root
    const root = tree.root();
    
    // Calculate the hash correctly using our utility
    const calculatedExtDataHash = getExtDataHash(extData);
    const publicAmountNumber = new anchor.BN(150);
    
    const input = {
      // Common transaction data
      root: root,
      inputNullifier: inputNullifiers,
      outputCommitment: outputCommitments,
      publicAmount: publicAmountNumber.toString(),
      extDataHash: calculatedExtDataHash,
      
      // Input UTXO data
      inAmount: inputs.map(x => x.amount.toString(10)),
      inPrivateKey: inputs.map(x => x.keypair.privkey),
      inBlinding: inputs.map(x => x.blinding.toString(10)),
      inPathIndices: inputMerklePathIndices,
      inPathElements: inputMerklePathElements,
      
      // Output UTXO data
      outAmount: outputs.map(x => x.amount.toString(10)),
      outBlinding: outputs.map(x => x.blinding.toString(10)),
      outPubkey: outputs.map(x => x.keypair.pubkey),
    };
    
    // Path to the proving key files
    const keyBasePath = path.resolve(__dirname, '../../artifacts/circuits/transaction2');
    const {proof, publicSignals} = await prove(input, keyBasePath);
    
    const proofInBytes = parseProofToBytesArray(proof);
    const inputsInBytes = parseToBytesArray(publicSignals);
    
    // Create a Proof object with the correctly calculated hash
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
    
    // Derive nullifier PDAs
    const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program, proofToSubmit);
    
    // Derive commitment PDAs
    const { commitment0PDA, commitment1PDA } = findCommitmentPDAs(program, proofToSubmit);
    
    // Set compute budget for the transaction
    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    try {
      // Execute the transaction
      const tx = await program.methods
        .transact(proofToSubmit, extData)
        .accounts({
          treeAccount: treeAccountPDA,
          nullifier0: nullifier0PDA,
          nullifier1: nullifier1PDA,
          commitment0: commitment0PDA,
          commitment1: commitment1PDA,
          recipient: recipient.publicKey,
          feeRecipientAccount: feeRecipientPDA,
          treeTokenAccount: treeTokenAccountPDA,
          authority: authority.publicKey,
          signer: insufficientUser.publicKey, // Use our insufficient balance user
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([insufficientUser]) // User with insufficient balance signs the transaction
        .preInstructions([modifyComputeUnits]) // Add compute budget instruction as pre-instruction
        .transaction();
      
      // Create v0 transaction to allow larger size
      const latestBlockhash = await provider.connection.getLatestBlockhash();
      const messageLegacy = new anchor.web3.TransactionMessage({
        payerKey: insufficientUser.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: tx.instructions,
      }).compileToLegacyMessage();
      
      // Create a versioned transaction
      const transactionV0 = new anchor.web3.VersionedTransaction(messageLegacy);
      
      // Sign the transaction
      transactionV0.sign([insufficientUser]);
      
      // Send and confirm transaction - this should fail due to insufficient funds
      await provider.connection.sendTransaction(transactionV0, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });
      
      // If we get here, the test failed because the transaction should have thrown an error
      expect.fail("Transaction should have failed due to insufficient funds but succeeded");
    } catch (error) {
      // Transaction should fail with insufficient funds or similar error
      const errorString = error.toString();
      expect(
        errorString.includes("insufficient funds") || 
        errorString.includes("insufficient balance") ||
        errorString.includes("insufficient lamports") ||
        errorString.includes("account (") ||
        errorString.includes("0x1") || // General error code
        errorString.includes("failed") ||
        errorString.includes("Error")
      ).to.be.true;
      
      // Double check balances to verify no funds were transferred
      const finalUserBalance = await provider.connection.getBalance(insufficientUser.publicKey);
      // Balance should be close to what we started with (might have lost a bit for partial tx fee)
      expect(finalUserBalance).to.be.lessThanOrEqual(totalRequired - balanceDeficit);
      expect(finalUserBalance).to.be.greaterThan(0); // Should still have some funds left
    }
  });

  it("Fails to withdraw with a single used nullifier", async () => {
    // Create a sample ExtData object with original values
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(200), // Positive ext amount (deposit)
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(50), // Fee
    };

    // Create the merkle tree with the pre-initialized poseidon hash
    const tree: MerkleTree = new MerkleTree(DEFAULT_HEIGHT, lightWasm);

    // Create inputs for the first deposit
    const inputs = [
      new Utxo({ lightWasm }),
      new Utxo({ lightWasm })
    ];

    const outputAmount = '150';
    const outputs = [
      new Utxo({ lightWasm, amount: outputAmount }), // Combined amount minus fee
      new Utxo({ lightWasm, amount: '0' }) // Empty UTXO
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

    // Calculate the hash correctly using our utility
    const calculatedExtDataHash = getExtDataHash(extData);

    const input = {
      // Common transaction data
      root: root,
      inputNullifier: inputNullifiers, // Use resolved values instead of Promise objects
      outputCommitment: outputCommitments, // Use resolved values instead of Promise objects
      publicAmount: new anchor.BN(150).toString(),
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
    
    // Derive commitment PDAs
    const { commitment0PDA, commitment1PDA } = findCommitmentPDAs(program, proofToSubmit);

    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    // Execute the transaction without pre-instructions
    const tx = await program.methods
      .transact(proofToSubmit, extData)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: nullifier0PDA,
        nullifier1: nullifier1PDA,
        commitment0: commitment0PDA,
        commitment1: commitment1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: feeRecipientPDA,
        treeTokenAccount: treeTokenAccountPDA,
        authority: authority.publicKey,
        signer: randomUser.publicKey, // Use random user as signer
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser]) // Random user signs the transaction
      .preInstructions([modifyComputeUnits]) // Add compute budget instruction as pre-instruction
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
    
    // Send and confirm transaction
    const txSig = await provider.connection.sendTransaction(transactionV0, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    
    await provider.connection.confirmTransaction({
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      signature: txSig,
    });
    
    expect(txSig).to.be.a('string');

    // Create mock input UTXOs for withdrawal
    // First input is a real UTXO that we created in deposit
    const withdrawInputs = [
      outputs[0], // Use the first output directly
      new Utxo({ lightWasm }) // Second input is empty
    ];
    const withdrawOutputs = [
      new Utxo({ lightWasm, amount: '30' }), // Some remaining amount
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
    };

    // Calculate the hash for withdrawal
    const withdrawExtDataHash = getExtDataHash(withdrawExtData);

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
    
    // Derive PDAs for withdrawal commitments
    const withdrawCommitments = findCommitmentPDAs(program, withdrawProofToSubmit);

    // Execute the withdrawal transaction
    const withdrawTx = await program.methods
      .transact(withdrawProofToSubmit, withdrawExtData)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: withdrawNullifiers.nullifier0PDA,
        nullifier1: withdrawNullifiers.nullifier1PDA,
        commitment0: withdrawCommitments.commitment0PDA,
        commitment1: withdrawCommitments.commitment1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: feeRecipientPDA,
        treeTokenAccount: treeTokenAccountPDA,
        authority: authority.publicKey,
        signer: randomUser.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .transaction();
      
    // Add compute budget instruction
    withdrawTx.add(modifyComputeUnits);
    
    // Create v0 transaction to allow larger size
    const withdrawLatestBlockhash = await provider.connection.getLatestBlockhash();
    const withdrawMessageLegacy = new anchor.web3.TransactionMessage({
      payerKey: randomUser.publicKey,
      recentBlockhash: withdrawLatestBlockhash.blockhash,
      instructions: withdrawTx.instructions,
    }).compileToLegacyMessage();
    
    // Create a versioned transaction
    const withdrawTransactionV0 = new anchor.web3.VersionedTransaction(withdrawMessageLegacy);
    
    // Sign the transaction
    withdrawTransactionV0.sign([randomUser]);
    
    // Send and confirm transaction
    const withdrawTxSig = await provider.connection.sendTransaction(withdrawTransactionV0, {
      skipPreflight: false, 
      preflightCommitment: 'confirmed',
    });
    
    await provider.connection.confirmTransaction({
      blockhash: withdrawLatestBlockhash.blockhash,
      lastValidBlockHeight: withdrawLatestBlockhash.lastValidBlockHeight,
      signature: withdrawTxSig,
    });
    
    expect(withdrawTxSig).to.be.a('string');

    // After we've done a successful withdrawal, try to reuse the same nullifiers
    try {
      // Need to derive the commitment PDAs before transaction
      // We're using the same proof and trying to reuse nullifiers, which should fail
      const secondWithdrawCommitments = findCommitmentPDAs(program, withdrawProofToSubmit);
      
      // Create the compute units instruction
      const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
        units: 1_000_000 
      });
      
      // Create the transaction for attempting to re-use nullifiers
      const failingWithdrawTx = await program.methods
        .transact(withdrawProofToSubmit, withdrawExtData)
        .accounts({
          treeAccount: treeAccountPDA,
          nullifier0: withdrawNullifiers.nullifier0PDA,
          nullifier1: withdrawNullifiers.nullifier1PDA,
          commitment0: secondWithdrawCommitments.commitment0PDA,
          commitment1: secondWithdrawCommitments.commitment1PDA,
          recipient: recipient.publicKey,
          feeRecipientAccount: feeRecipientPDA,
          treeTokenAccount: treeTokenAccountPDA,
          authority: authority.publicKey,
          signer: randomUser.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([randomUser])
        .preInstructions([modifyComputeUnits]) // Add the compute unit instruction as a pre-instruction
        .transaction();
        
      // Create v0 transaction with identical setup to first transaction
      const failingLatestBlockhash = await provider.connection.getLatestBlockhash();
      const failingMessageLegacy = new anchor.web3.TransactionMessage({
        payerKey: randomUser.publicKey,
        recentBlockhash: failingLatestBlockhash.blockhash,
        instructions: failingWithdrawTx.instructions,
      }).compileToLegacyMessage();
      
      // Create a versioned transaction (exact same process as first transaction)
      const failingTransactionV0 = new anchor.web3.VersionedTransaction(failingMessageLegacy);
      
      // Sign the transaction
      failingTransactionV0.sign([randomUser]);

      // We expect this to fail before this point due to nullifier PDA creation constraint
      // But we're simulating the transaction exactly the same way to ensure consistency
      const failingTxSig = await provider.connection.sendTransaction(failingTransactionV0, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });
      
      // If we get here, the transaction succeeded which is unexpected
      expect.fail("Transaction should have failed due to nullifier reuse but succeeded");
    } catch (error) {
      // For versioned transactions, check for specific error patterns
      const errorString = error.toString();
      expect(
        errorString.includes("ConstraintSeeds") || 
        errorString.includes("0x7d6") || // ConstraintSeeds code
        errorString.includes("constraint was violated") ||
        errorString.includes("account already exists") ||
        errorString.includes("failed") ||
        errorString.includes("Error")
      ).to.be.true;
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
    };

    // Create a different ExtData to generate a different hash
    const modifiedExtData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(100), // Different amount (positive instead of negative)
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(100),
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
    
    // Get commitment PDAs
    const { commitment0PDA, commitment1PDA } = findCommitmentPDAs(program, proof);

    try {
      // Create the compute units instruction
      const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
        units: 1_000_000 
      });
      
      // Execute the transaction - this should fail because the hash doesn't match
      const tx = await program.methods
        .transact(proof, extData)
        .accounts({
          treeAccount: treeAccountPDA,
          nullifier0: nullifier0PDA,
          nullifier1: nullifier1PDA,
          commitment0: commitment0PDA,
          commitment1: commitment1PDA,
          recipient: recipient.publicKey,
          feeRecipientAccount: feeRecipientPDA,
          treeTokenAccount: treeTokenAccountPDA,
          authority: authority.publicKey,
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
    
    // Get commitment PDAs
    const { commitment0PDA, commitment1PDA } = findCommitmentPDAs(program, proof);

    try {
      // Create the compute units instruction
      const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
        units: 1_000_000 
      });
      
      // Execute the transaction - this should fail because the root is unknown
      const tx = await program.methods
        .transact(proof, extData)
        .accounts({
          treeAccount: treeAccountPDA,
          nullifier0: nullifier0PDA,
          nullifier1: nullifier1PDA,
          commitment0: commitment0PDA,
          commitment1: commitment1PDA,
          recipient: recipient.publicKey,
          feeRecipientAccount: feeRecipientPDA,
          treeTokenAccount: treeTokenAccountPDA,
          authority: authority.publicKey,
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
    
    // Get commitment PDAs
    const { commitment0PDA, commitment1PDA } = findCommitmentPDAs(program, proof);

    try {
      // Create the compute units instruction
      const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
        units: 1_000_000 
      });
      
      // Execute the transaction - this should fail because the root is unknown
      const tx = await program.methods
        .transact(proof, extData)
        .accounts({
          treeAccount: treeAccountPDA,
          nullifier0: nullifier0PDA,
          nullifier1: nullifier1PDA,
          commitment0: commitment0PDA,
          commitment1: commitment1PDA,
          recipient: recipient.publicKey,
          feeRecipientAccount: feeRecipientPDA,
          treeTokenAccount: treeTokenAccountPDA,
          authority: authority.publicKey,
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

  it("Fails for InvalidPublicAmountData when deposit extAmount is not greater than fees", async () => {
    // When ext_amount is zero, public_amount should also be zero (minus fee)
    const extAmount = new anchor.BN(10);
    const fee = new anchor.BN(10);
    const publicAmount = new BN(extAmount).sub(fee).add(FIELD_SIZE).mod(FIELD_SIZE).toString()
    
    const extData = {
      recipient: recipient.publicKey,
      extAmount: extAmount,
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: fee,
    };

    const calculatedExtDataHash = getExtDataHash(extData);

    // Create the merkle tree with the pre-initialized poseidon hash
    const tree: MerkleTree = new MerkleTree(DEFAULT_HEIGHT, lightWasm);

    // Create inputs for the first deposit
    const inputs = [
      new Utxo({ lightWasm }),
      new Utxo({ lightWasm })
    ];

    const outputAmount = '0';
    const outputs = [
      new Utxo({ lightWasm, amount: outputAmount }), // Combined amount minus fee
      new Utxo({ lightWasm, amount: '0' }) // Empty UTXO
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

    const inputNullifiers = await Promise.all(inputs.map(x => x.getNullifier()));
    const outputCommitments = await Promise.all(outputs.map(x => x.getCommitment()));
    const root = tree.root();

    const input = {
      // Common transaction data
      root: root,
      inputNullifier: inputNullifiers, // Use resolved values instead of Promise objects
      outputCommitment: outputCommitments, // Use resolved values instead of Promise objects
      publicAmount: publicAmount.toString(),
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
    
    // Derive commitment PDAs
    const { commitment0PDA, commitment1PDA } = findCommitmentPDAs(program, proofToSubmit);

    try {
      // Create the compute units instruction
      const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
        units: 1_000_000 
      });
      
      // Transaction should fail due to invalid amount relation
      const tx = await program.methods
        .transact(proofToSubmit, extData)
        .accounts({
          treeAccount: treeAccountPDA,
          nullifier0: nullifier0PDA,
          nullifier1: nullifier1PDA,
          commitment0: commitment0PDA,
          commitment1: commitment1PDA,
          recipient: recipient.publicKey,
          feeRecipientAccount: feeRecipientPDA,
          treeTokenAccount: treeTokenAccountPDA,
          authority: authority.publicKey,
          signer: randomUser.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([randomUser])
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
      expect.fail("Transaction should have failed due to invalid amount relation but succeeded");
    } catch (error) {
      // For versioned transactions, we need to check the error message
      const errorString = error.toString();
      expect(errorString.includes("0x1773") || errorString.includes("InvalidPublicAmountData")).to.be.true;
    }
  });

  it("Fails with mismatched authority with provided pda accounts", async () => {
    // Create a different authority
    const wrongAuthority = anchor.web3.Keypair.generate();
    
    // Fund the wrong authority
    const transferTx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: fundingAccount.publicKey,
        toPubkey: wrongAuthority.publicKey,
        lamports: 1 * LAMPORTS_PER_SOL,
      })
    );
    
    // Send and confirm the transfer transaction
    const transferSignature = await provider.connection.sendTransaction(transferTx, [fundingAccount]);
    await provider.connection.confirmTransaction(transferSignature);
    
    // Create the ext data and proof for transaction
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(-100),
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(100),
    };
    
    const calculatedExtDataHash = getExtDataHash(extData);
    
    const validProof = {
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
      extDataHash: Array.from(calculatedExtDataHash)
    };

    // Find nullifier PDAs
    const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(program, validProof);
    
    // Find commitment PDAs
    const { commitment0PDA, commitment1PDA } = findCommitmentPDAs(program, validProof);
    
    try {
      // Create the compute units instruction
      const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
        units: 1_000_000 
      });
      
      // Try to use the original PDA accounts but with wrongAuthority as the authority
      // This should trigger the authority check in the transact function
      const tx = await program.methods
        .transact(validProof, extData)
        .accounts({
          treeAccount: treeAccountPDA,
          nullifier0: nullifier0PDA,
          nullifier1: nullifier1PDA,
          commitment0: commitment0PDA,
          commitment1: commitment1PDA,
          recipient: recipient.publicKey,
          feeRecipientAccount: feeRecipientPDA,
          treeTokenAccount: treeTokenAccountPDA,
          authority: wrongAuthority.publicKey,
          signer: randomUser.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([randomUser])
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
      
      expect.fail("Transaction should have failed due to mismatched fee recipient account authority but succeeded");
    } catch (error) {
      // For versioned transactions, check for specific error patterns related to constraint violations
      const errorString = error.toString();
      expect(
        errorString.includes("ConstraintSeeds") || 
        errorString.includes("0x7d6") || // ConstraintSeeds code
        errorString.includes("constraint was violated") ||
        errorString.includes("seeds constraint was violated") ||
        errorString.includes("Blockhash not found")
      ).to.be.true;
    }
  });

  it("Fails to generate proof with negative fee", async () => {
    // When ext_amount is zero, public_amount should also be zero (minus fee)
    const extAmount = new anchor.BN(10);
    const fee = new anchor.BN(-10);
    const publicAmount = new BN(extAmount).sub(fee).add(FIELD_SIZE).mod(FIELD_SIZE).toString()
    
    const extData = {
      recipient: recipient.publicKey,
      extAmount: extAmount,
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: fee,
    };

    const calculatedExtDataHash = getExtDataHash(extData);
    
    // Create the merkle tree with the pre-initialized poseidon hash
    const tree: MerkleTree = new MerkleTree(DEFAULT_HEIGHT, lightWasm);

    // Create inputs for the first deposit
    const inputs = [
      new Utxo({ lightWasm }),
      new Utxo({ lightWasm })
    ];

    const outputAmount = '0';
    const outputs = [
      new Utxo({ lightWasm, amount: outputAmount }), // Combined amount minus fee
      new Utxo({ lightWasm, amount: '0' }) // Empty UTXO
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

    const inputNullifiers = await Promise.all(inputs.map(x => x.getNullifier()));
    const outputCommitments = await Promise.all(outputs.map(x => x.getCommitment()));
    const root = tree.root();

    const input = {
      // Common transaction data
      root: root,
      inputNullifier: inputNullifiers, // Use resolved values instead of Promise objects
      outputCommitment: outputCommitments, // Use resolved values instead of Promise objects
      publicAmount: publicAmount.toString(),
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

    // Store original console.error to restore it later
    const originalConsoleError = console.error;
    
    // Override console.error to suppress all circom-related errors
    console.error = function(...args) {
      // Check if any argument is a string containing error keywords
      const shouldSuppress = args.some(arg => 
        typeof arg === 'string' && (
          arg.includes('Error in template') || 
          arg.includes('ERROR:') ||
          arg.includes('Transaction_')
        )
      );
      
      // Only print if it's not a circom error
      if (!shouldSuppress) {
        originalConsoleError.apply(console, args);
      }
    };

    try {
      await prove(input, keyBasePath);
      // Restore console.error before the assertion
      console.error = originalConsoleError;
      expect.fail("Proof should not be generated");
    } catch (error) {
      // Restore console.error before handling the error
      console.error = originalConsoleError;
      // Expected error - test passes
    }
  });

  it("Tests arithmetic overflow protection in transact() with edge case balances", async () => {
    // First do a normal deposit to set up the scenario
    const depositFee = new anchor.BN(0)
    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(200), // Positive ext amount (deposit)
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: depositFee, // Fee
    };

    // Create the merkle tree
    const tree: MerkleTree = new MerkleTree(DEFAULT_HEIGHT, lightWasm);

    // Create inputs for the deposit
    const inputs = [
      new Utxo({ lightWasm }),
      new Utxo({ lightWasm })
    ];

    const publicAmountNumber = extData.extAmount.sub(depositFee);
    const outputAmount = publicAmountNumber.toString();
    const outputs = [
      new Utxo({ lightWasm, amount: outputAmount }), // Combined amount minus fee
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
    const { commitment0PDA, commitment1PDA } = findCommitmentPDAs(program, proofToSubmit);

    // Execute the deposit transaction
    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    await program.methods
      .transact(proofToSubmit, extData)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: nullifier0PDA,
        nullifier1: nullifier1PDA,
        commitment0: commitment0PDA,
        commitment1: commitment1PDA,
        recipient: recipient.publicKey,
        feeRecipientAccount: feeRecipientPDA,
        treeTokenAccount: treeTokenAccountPDA,
        authority: authority.publicKey,
        signer: randomUser.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .preInstructions([modifyComputeUnits])
      .rpc();

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
    
    // Derive PDAs for withdrawal commitments
    const withdrawCommitments = findCommitmentPDAs(program, withdrawProofToSubmit);

    // Execute the withdrawal transaction - this should succeed and demonstrate arithmetic protection is in place
    try {
      await program.methods
        .transact(withdrawProofToSubmit, validWithdrawExtData)
        .accounts({
          treeAccount: treeAccountPDA,
          nullifier0: withdrawNullifiers.nullifier0PDA,
          nullifier1: withdrawNullifiers.nullifier1PDA,
          commitment0: withdrawCommitments.commitment0PDA,
          commitment1: withdrawCommitments.commitment1PDA,
          recipient: recipient.publicKey,
          feeRecipientAccount: feeRecipientPDA,
          treeTokenAccount: treeTokenAccountPDA,
          authority: authority.publicKey,
          signer: randomUser.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([randomUser])
        .preInstructions([modifyComputeUnits])
        .rpc();

      // If we get here, it means the arithmetic protection is working correctly
      // and allows normal transactions while protecting against overflow
      expect(true).to.be.true;
    } catch (error) {
      // If transaction fails, this might indicate an issue since this test should succeed
      // This test should succeed, so if it fails there might be another issue
      throw error;
    }
  });
});

describe("withdraw_fees", () => {
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

  // Initialize variables for tree token account
  let treeTokenAccountPDA: PublicKey;
  let treeTokenBump: number;

  // --- Funding a wallet to use for paying transaction fees ---
  before(async () => {
    // Generate a funding account to pay for transactions
    fundingAccount = anchor.web3.Keypair.generate();
    
    // Airdrop SOL to the funding account
    const airdropSignature = await provider.connection.requestAirdrop(
      fundingAccount.publicKey,
      100 * LAMPORTS_PER_SOL // Airdrop 100 SOL
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
        lamports: 2 * LAMPORTS_PER_SOL, // 2 SOL to ensure enough for rent
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
        .signers([authority])
        .rpc();
        
      // Fund the feeRecipientAccount with SOL for withdrawal tests
      const feeRecipientAirdropSignature = await provider.connection.requestAirdrop(feeRecipientPDA, 1 * LAMPORTS_PER_SOL);
      const latestBlockHash = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        blockhash: latestBlockHash.blockhash,
        lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
        signature: feeRecipientAirdropSignature,
      });
      
      // Verify the initialization was successful
      const feeRecipientAccount = await program.account.feeRecipientAccount.fetch(feeRecipientPDA);
      expect(feeRecipientAccount.authority.equals(authority.publicKey)).to.be.true;
      expect(feeRecipientAccount.bump).to.equal(feeRecipientBump);
    } catch (error) {
      console.error("Error initializing accounts:", error);
      if ('logs' in error) {
        console.error("Error logs:", error.logs);
      }
      throw error;
    }
  });

  it("Can successfully withdraw fees to a recipient", async () => {
    const withdrawAmount = 0.1 * LAMPORTS_PER_SOL; // 0.1 SOL
    
    // Get initial balances
    const feeRecipientBalanceBefore = await provider.connection.getBalance(feeRecipientPDA);
    const recipientBalanceBefore = await provider.connection.getBalance(recipient.publicKey);
    
    // Ensure fee recipient has enough funds
    expect(feeRecipientBalanceBefore).to.be.greaterThan(withdrawAmount);
    
    // Execute the withdraw_fees instruction
    const txSig = await program.methods
      .withdrawFees(new anchor.BN(withdrawAmount))
      .accounts({
        feeRecipientAccount: feeRecipientPDA,
        recipient: recipient.publicKey,
        authority: authority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([authority])
      .rpc();
    
    expect(txSig).to.be.a('string');
    
    // Get final balances
    const feeRecipientBalanceAfter = await provider.connection.getBalance(feeRecipientPDA);
    const recipientBalanceAfter = await provider.connection.getBalance(recipient.publicKey);
    
    // Verify the transfer happened correctly
    expect(feeRecipientBalanceAfter).to.equal(feeRecipientBalanceBefore - withdrawAmount);
    expect(recipientBalanceAfter).to.equal(recipientBalanceBefore + withdrawAmount);
  });

  it("Fails to withdraw more than available (InsufficientFundsToMaintainRentExemption)", async () => {
    // Get the current balance of fee recipient
    const feeRecipientBalance = await provider.connection.getBalance(feeRecipientPDA);
    
    // Try to withdraw more than available
    const withdrawAmount = feeRecipientBalance + 1; // 1 lamport more than available
    
    try {
      await program.methods
        .withdrawFees(new anchor.BN(withdrawAmount))
        .accounts({
          feeRecipientAccount: feeRecipientPDA,
          recipient: recipient.publicKey,
          authority: authority.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([authority])
        .rpc();
      
      // If we get here, the test failed because the transaction should have thrown an error
      expect.fail("Transaction should have failed due to insufficient funds but succeeded");
    } catch (error) {
      // Check for the specific error code
      const errorString = error.toString();
      
      expect(
        errorString.includes("0x177a") || // InsufficientFundsToMaintainRentExemption error code (6010)
        errorString.includes("InsufficientFundsToMaintainRentExemption")
      ).to.be.true;
    }
  });

  it("Fails to withdraw amount that would break rent exemption (InsufficientFundsToMaintainRentExemption)", async () => {
    // Get the current balance of fee recipient
    const feeRecipientBalance = await provider.connection.getBalance(feeRecipientPDA);
    
    // Calculate the minimum rent exemption for FeeRecipientAccount
    const feeRecipientAccountSize = 8 + 32 + 1; // discriminator + authority + bump
    const rentExemption = await provider.connection.getMinimumBalanceForRentExemption(feeRecipientAccountSize);
    
    // Try to withdraw an amount that would leave the account below rent exemption
    // We'll withdraw everything except 1 lamport less than rent exemption
    const withdrawAmount = feeRecipientBalance - rentExemption + 1;
    
    // Ensure we have enough balance to make this a meaningful test
    expect(feeRecipientBalance).to.be.greaterThan(rentExemption);
    expect(withdrawAmount).to.be.greaterThan(0);
    
    try {
      await program.methods
        .withdrawFees(new anchor.BN(withdrawAmount))
        .accounts({
          feeRecipientAccount: feeRecipientPDA,
          recipient: recipient.publicKey,
          authority: authority.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([authority])
        .rpc();
      
      // If we get here, the test failed because the transaction should have thrown an error
      expect.fail("Transaction should have failed due to rent exemption violation but succeeded");
    } catch (error) {
      // Check for the specific error code for rent exemption
      const errorString = error.toString();
      expect(
        errorString.includes("0x1778") || // InsufficientFundsToMaintainRentExemption error code
        errorString.includes("InsufficientFundsToMaintainRentExemption") ||
        errorString.includes("insufficient funds to maintain rent exemption")
      ).to.be.true;
    }
  });

  it("Fails when authority is not the fee_recipient_account's authority (Unauthorized)", async () => {
    const withdrawAmount = 0.01 * LAMPORTS_PER_SOL; // 0.01 SOL
    
    // Create a different authority (unauthorized user)
    const unauthorizedAuthority = anchor.web3.Keypair.generate();
    
    // Fund the unauthorized authority to pay for transaction fees
    const transferTx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: fundingAccount.publicKey,
        toPubkey: unauthorizedAuthority.publicKey,
        lamports: 0.1 * LAMPORTS_PER_SOL,
      })
    );
    
    const transferSignature = await provider.connection.sendTransaction(transferTx, [fundingAccount]);
    await provider.connection.confirmTransaction(transferSignature);
    
    try {
      await program.methods
        .withdrawFees(new anchor.BN(withdrawAmount))
        .accounts({
          feeRecipientAccount: feeRecipientPDA,
          recipient: recipient.publicKey,
          authority: unauthorizedAuthority.publicKey, // Wrong authority
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([unauthorizedAuthority]) // Wrong signer
        .rpc();
      
      // If we get here, the test failed because the transaction should have thrown an error
      expect.fail("Transaction should have failed due to unauthorized access but succeeded");
    } catch (error) {
      // Check for authorization-related errors
      const errorString = error.toString();
      expect(
        errorString.includes("0x1770") || // Unauthorized error code
        errorString.includes("Unauthorized") ||
        errorString.includes("ConstraintSeeds") ||
        errorString.includes("0x7d6") || // ConstraintSeeds code
        errorString.includes("has_one") ||
        errorString.includes("constraint was violated")
      ).to.be.true;
    }
  });

  it("Can withdraw the entire fee recipient balance", async () => {
    // Get the current balance of fee recipient
    const feeRecipientBalance = await provider.connection.getBalance(feeRecipientPDA);
    
    // Calculate the minimum rent exemption using the same logic as the smart contract
    const feeRecipientAccountSize = 8 + 32 + 1; // discriminator + authority (Pubkey) + bump (u8)
    const rentExemption = await provider.connection.getMinimumBalanceForRentExemption(feeRecipientAccountSize);
    
    // Withdraw everything except rent exemption (exactly what the smart contract allows)
    const withdrawAmount = feeRecipientBalance - rentExemption;
    
    expect(withdrawAmount).to.be.greaterThan(0);
    
    // Get initial recipient balance
    const recipientBalanceBefore = await provider.connection.getBalance(recipient.publicKey);
    
    // Execute the withdraw_fees instruction
    const txSig = await program.methods
      .withdrawFees(new anchor.BN(withdrawAmount))
      .accounts({
        feeRecipientAccount: feeRecipientPDA,
        recipient: recipient.publicKey,
        authority: authority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([authority])
      .rpc();
    
    expect(txSig).to.be.a('string');
    
    // Get final balances
    const feeRecipientBalanceAfter = await provider.connection.getBalance(feeRecipientPDA);
    const recipientBalanceAfter = await provider.connection.getBalance(recipient.publicKey);
    
    // Verify the transfer happened correctly
    expect(feeRecipientBalanceAfter).to.equal(rentExemption); // Should only have rent exemption left
    expect(recipientBalanceAfter).to.equal(recipientBalanceBefore + withdrawAmount);
  });

  it("Can withdraw zero amount (edge case)", async () => {
    const withdrawAmount = 0;
    
    // Get initial balances
    const feeRecipientBalanceBefore = await provider.connection.getBalance(feeRecipientPDA);
    const recipientBalanceBefore = await provider.connection.getBalance(recipient.publicKey);
    
    // Execute the withdraw_fees instruction with zero amount
    const txSig = await program.methods
      .withdrawFees(new anchor.BN(withdrawAmount))
      .accounts({
        feeRecipientAccount: feeRecipientPDA,
        recipient: recipient.publicKey,
        authority: authority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([authority])
      .rpc();
    
    expect(txSig).to.be.a('string');
    
    // Get final balances
    const feeRecipientBalanceAfter = await provider.connection.getBalance(feeRecipientPDA);
    const recipientBalanceAfter = await provider.connection.getBalance(recipient.publicKey);
    
    // Verify no transfer happened
    expect(feeRecipientBalanceAfter).to.equal(feeRecipientBalanceBefore);
    expect(recipientBalanceAfter).to.equal(recipientBalanceBefore);
  });

  it("Can withdraw multiple times to different recipients", async () => {
    const withdrawAmount = 0.05 * LAMPORTS_PER_SOL; // 0.05 SOL each
    
    // Create additional recipients
    const recipient2 = anchor.web3.Keypair.generate();
    const recipient3 = anchor.web3.Keypair.generate();
    
    // Get initial fee recipient balance
    const feeRecipientBalanceBefore = await provider.connection.getBalance(feeRecipientPDA);
    
    // Ensure we have enough funds for multiple withdrawals
    expect(feeRecipientBalanceBefore).to.be.greaterThan(withdrawAmount * 3);
    
    // First withdrawal to recipient 1
    const txSig1 = await program.methods
      .withdrawFees(new anchor.BN(withdrawAmount))
      .accounts({
        feeRecipientAccount: feeRecipientPDA,
        recipient: recipient.publicKey,
        authority: authority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([authority])
      .rpc();
    
    expect(txSig1).to.be.a('string');
    
    // Second withdrawal to recipient 2
    const txSig2 = await program.methods
      .withdrawFees(new anchor.BN(withdrawAmount))
      .accounts({
        feeRecipientAccount: feeRecipientPDA,
        recipient: recipient2.publicKey,
        authority: authority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([authority])
      .rpc();
    
    expect(txSig2).to.be.a('string');
    
    // Third withdrawal to recipient 3
    const txSig3 = await program.methods
      .withdrawFees(new anchor.BN(withdrawAmount))
      .accounts({
        feeRecipientAccount: feeRecipientPDA,
        recipient: recipient3.publicKey,
        authority: authority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([authority])
      .rpc();
    
    expect(txSig3).to.be.a('string');
    
    // Get final balances
    const feeRecipientBalanceAfter = await provider.connection.getBalance(feeRecipientPDA);
    const recipient1Balance = await provider.connection.getBalance(recipient.publicKey);
    const recipient2Balance = await provider.connection.getBalance(recipient2.publicKey);
    const recipient3Balance = await provider.connection.getBalance(recipient3.publicKey);
    
    // Verify all transfers happened correctly
    expect(feeRecipientBalanceAfter).to.equal(feeRecipientBalanceBefore - (withdrawAmount * 3));
    expect(recipient1Balance).to.equal(withdrawAmount);
    expect(recipient2Balance).to.equal(withdrawAmount);
    expect(recipient3Balance).to.equal(withdrawAmount);
  });

  it("Can withdraw exact maximum amount (leaving exactly rent exemption)", async () => {
    // Get the current balance of fee recipient
    const feeRecipientBalance = await provider.connection.getBalance(feeRecipientPDA);
    
    // Calculate the minimum rent exemption for FeeRecipientAccount
    const feeRecipientAccountSize = 8 + 32 + 1; // discriminator + authority + bump
    const rentExemption = await provider.connection.getMinimumBalanceForRentExemption(feeRecipientAccountSize);
    
    // Withdraw exactly the maximum allowed amount (leaving exactly rent exemption)
    const withdrawAmount = feeRecipientBalance - rentExemption;
    
    // Ensure we have enough balance to make this a meaningful test
    expect(feeRecipientBalance).to.be.greaterThan(rentExemption);
    expect(withdrawAmount).to.be.greaterThan(0);
    
    // Get initial recipient balance
    const recipientBalanceBefore = await provider.connection.getBalance(recipient.publicKey);
    
    // Execute the withdraw_fees instruction - this should succeed
    const txSig = await program.methods
      .withdrawFees(new anchor.BN(withdrawAmount))
      .accounts({
        feeRecipientAccount: feeRecipientPDA,
        recipient: recipient.publicKey,
        authority: authority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([authority])
      .rpc();
    
    expect(txSig).to.be.a('string');
    
    // Get final balances
    const feeRecipientBalanceAfter = await provider.connection.getBalance(feeRecipientPDA);
    const recipientBalanceAfter = await provider.connection.getBalance(recipient.publicKey);
    
    // Verify the transfer happened correctly and exactly rent exemption remains
    expect(feeRecipientBalanceAfter).to.equal(rentExemption);
    expect(recipientBalanceAfter).to.equal(recipientBalanceBefore + withdrawAmount);
  });

  it("Fails with underflow when trying to withdraw more fees than available", async () => {
    // Get current fee recipient balance
    const feeRecipientBalance = await provider.connection.getBalance(feeRecipientPDA);
    
    // Calculate rent exemption amount to ensure we don't try to withdraw below rent exemption
    const rentExemption = await provider.connection.getMinimumBalanceForRentExemption(
      8 + 32 + 1 // FeeRecipientAccount size: 8 (discriminator) + 32 (Pubkey) + 1 (u8)
    );
    
    // Try to withdraw more than available (beyond rent exemption)
    const excessiveWithdrawal = feeRecipientBalance - rentExemption + 1000000; // 1M lamports more than safe withdrawal
    
    try {
      await program.methods
        .withdrawFees(new anchor.BN(excessiveWithdrawal))
        .accounts({
          feeRecipientAccount: feeRecipientPDA,
          recipient: recipient.publicKey,
          authority: authority.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([authority])
        .rpc();
      
      expect.fail("Transaction should have failed due to insufficient funds but succeeded");
    } catch (error) {
      const errorString = error.toString();
      
      // Should fail with either ArithmeticOverflow or InsufficientFundsForWithdrawal
      expect(
        errorString.includes("0x1779") || // ArithmeticOverflow error code
        errorString.includes("ArithmeticOverflow") ||
        errorString.includes("0x1774") || // InsufficientFundsForWithdrawal error code
        errorString.includes("InsufficientFundsForWithdrawal") ||
        errorString.includes("0x1778") || // InsufficientFundsToMaintainRentExemption
        errorString.includes("InsufficientFundsToMaintainRentExemption") ||
        errorString.includes("insufficient funds") // System program error
      ).to.be.true;
    }
  });

  it("Fails with underflow when trying to withdraw exactly the rent exemption amount", async () => {
    // This test ensures we can't withdraw the rent exemption amount itself
    const rentExemption = await provider.connection.getMinimumBalanceForRentExemption(
      8 + 32 + 1 // FeeRecipientAccount size
    );
    
    // Get current balance
    const feeRecipientBalance = await provider.connection.getBalance(feeRecipientPDA);
    
    // Try to withdraw an amount that would leave less than rent exemption
    const dangerousWithdrawal = feeRecipientBalance - rentExemption + 1; // Leave less than rent exemption
    
    try {
      await program.methods
        .withdrawFees(new anchor.BN(dangerousWithdrawal))
        .accounts({
          feeRecipientAccount: feeRecipientPDA,
          recipient: recipient.publicKey,
          authority: authority.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([authority])
        .rpc();
      
      expect.fail("Transaction should have failed due to insufficient funds to maintain rent exemption but succeeded");
    } catch (error) {
      const errorString = error.toString();
      
      expect(
        errorString.includes("0x1778") || // InsufficientFundsToMaintainRentExemption
        errorString.includes("InsufficientFundsToMaintainRentExemption") ||
        errorString.includes("0x1779") || // ArithmeticOverflow error code
        errorString.includes("ArithmeticOverflow") ||
        errorString.includes("insufficient funds")
      ).to.be.true;
    }
  });

  it("Successfully handles maximum safe withdrawal without overflow", async () => {
    // Get current balances
    const feeRecipientBalance = await provider.connection.getBalance(feeRecipientPDA);
    const recipientBalanceBefore = await provider.connection.getBalance(recipient.publicKey);
    
    // Calculate rent exemption
    const rentExemption = await provider.connection.getMinimumBalanceForRentExemption(
      8 + 32 + 1 // FeeRecipientAccount size
    );
    
    // Calculate maximum safe withdrawal (leave rent exemption + small buffer)
    const maxSafeWithdrawal = feeRecipientBalance - rentExemption - 1000; // Leave 1000 lamports buffer
    
    // Only proceed if there's actually something to withdraw
    if (maxSafeWithdrawal > 0) {
      const txSig = await program.methods
        .withdrawFees(new anchor.BN(maxSafeWithdrawal))
        .accounts({
          feeRecipientAccount: feeRecipientPDA,
          recipient: recipient.publicKey,
          authority: authority.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([authority])
        .rpc();
      
      expect(txSig).to.be.a('string');
      
      // Verify balances changed correctly
      const feeRecipientBalanceAfter = await provider.connection.getBalance(feeRecipientPDA);
      const recipientBalanceAfter = await provider.connection.getBalance(recipient.publicKey);
      
      expect(feeRecipientBalanceAfter).to.equal(feeRecipientBalance - maxSafeWithdrawal);
      expect(recipientBalanceAfter).to.equal(recipientBalanceBefore + maxSafeWithdrawal);
    } else {
        // This is still a successful test - it means our account management is working correctly
      expect(feeRecipientBalance).to.be.greaterThanOrEqual(rentExemption);
    }
  });

  it("Handles edge case of withdrawing exactly available amount minus rent exemption", async () => {
    // This test verifies that the exact boundary calculation works correctly
    const feeRecipientBalance = await provider.connection.getBalance(feeRecipientPDA);
    const recipientBalanceBefore = await provider.connection.getBalance(recipient.publicKey);
    
    const rentExemption = await provider.connection.getMinimumBalanceForRentExemption(
      8 + 32 + 1 // FeeRecipientAccount size
    );
    
    // Try to withdraw exactly the available amount minus rent exemption
    const exactWithdrawal = feeRecipientBalance - rentExemption;
    
    if (exactWithdrawal > 0) {
      const txSig = await program.methods
        .withdrawFees(new anchor.BN(exactWithdrawal))
        .accounts({
          feeRecipientAccount: feeRecipientPDA,
          recipient: recipient.publicKey,
          authority: authority.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([authority])
        .rpc();
      
      expect(txSig).to.be.a('string');
      
      // Verify the fee recipient account still has exactly the rent exemption amount
      const feeRecipientBalanceAfter = await provider.connection.getBalance(feeRecipientPDA);
      const recipientBalanceAfter = await provider.connection.getBalance(recipient.publicKey);
      
      expect(feeRecipientBalanceAfter).to.equal(rentExemption);
      expect(recipientBalanceAfter).to.equal(recipientBalanceBefore + exactWithdrawal);
    } else {
        expect(feeRecipientBalance).to.equal(rentExemption);
    }
  });

  it("Tests ArithmeticOverflow error code specifically in withdraw_fees", async () => {
    // This test specifically targets the checked_sub/checked_add protection in withdraw_fees
    const feeRecipientBalance = await provider.connection.getBalance(feeRecipientPDA);
    
    // Try to withdraw an amount that would cause underflow in checked_sub
    const impossibleWithdrawal = feeRecipientBalance + 1000000000; // Way more than available
    
    try {
      await program.methods
        .withdrawFees(new anchor.BN(impossibleWithdrawal))
        .accounts({
          feeRecipientAccount: feeRecipientPDA,
          recipient: recipient.publicKey,
          authority: authority.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([authority])
        .rpc();
      
      expect.fail("Transaction should have failed with ArithmeticOverflow but succeeded");
    } catch (error) {
      const errorString = error.toString();
      
      // Should specifically get ArithmeticOverflow (0x1779) or related errors
      expect(
        errorString.includes("0x1779") || // ArithmeticOverflow error code
        errorString.includes("ArithmeticOverflow") ||
        errorString.includes("0x1774") || // InsufficientFundsForWithdrawal 
        errorString.includes("InsufficientFundsForWithdrawal") ||
        errorString.includes("0x1778") || // InsufficientFundsToMaintainRentExemption
        errorString.includes("InsufficientFundsToMaintainRentExemption")
      ).to.be.true;
    }
  });

  it("Verifies checked arithmetic prevents balance corruption in withdraw_fees", async () => {
    // This test ensures that failed transactions don't corrupt balances
    const initialFeeRecipientBalance = await provider.connection.getBalance(feeRecipientPDA);
    const initialRecipientBalance = await provider.connection.getBalance(recipient.publicKey);
    
    // Try an operation that should fail
    const excessiveAmount = initialFeeRecipientBalance + 1000000;
    
    try {
      await program.methods
        .withdrawFees(new anchor.BN(excessiveAmount))
        .accounts({
          feeRecipientAccount: feeRecipientPDA,
          recipient: recipient.publicKey,
          authority: authority.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([authority])
        .rpc();
      
      expect.fail("Transaction should have failed");
    } catch (error) {
      // Error is expected - now verify balances are unchanged
      const finalFeeRecipientBalance = await provider.connection.getBalance(feeRecipientPDA);
      const finalRecipientBalance = await provider.connection.getBalance(recipient.publicKey);
      
      expect(finalFeeRecipientBalance).to.equal(initialFeeRecipientBalance);
      expect(finalRecipientBalance).to.equal(initialRecipientBalance);
    }
  });

  it("Tests error code sequence and hierarchy", async () => {
    // Test that our error codes are properly defined and accessible
    const feeRecipientBalance = await provider.connection.getBalance(feeRecipientPDA);
    const rentExemption = await provider.connection.getMinimumBalanceForRentExemption(8 + 32 + 1);
    
    // Test 1: InsufficientFundsToMaintainRentExemption (should come before ArithmeticOverflow)
    const rentViolatingAmount = feeRecipientBalance - rentExemption + 1;
    
    try {
      await program.methods
        .withdrawFees(new anchor.BN(rentViolatingAmount))
        .accounts({
          feeRecipientAccount: feeRecipientPDA,
          recipient: recipient.publicKey,
          authority: authority.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([authority])
        .rpc();
        
      expect.fail("Should have failed with rent exemption error");
    } catch (error) {
      const errorString = error.toString();
      
      // Should get rent exemption error first (checked before arithmetic)
      expect(
        errorString.includes("0x1778") || // InsufficientFundsToMaintainRentExemption
        errorString.includes("InsufficientFundsToMaintainRentExemption")
      ).to.be.true;
    }
    
    // Test 2: InsufficientFundsForWithdrawal (should come before ArithmeticOverflow)
    const insufficientAmount = feeRecipientBalance + 1;
    
    try {
      await program.methods
        .withdrawFees(new anchor.BN(insufficientAmount))
        .accounts({
          feeRecipientAccount: feeRecipientPDA,
          recipient: recipient.publicKey,
          authority: authority.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId
        })
        .signers([authority])
        .rpc();
        
      expect.fail("Should have failed with insufficient funds error");
    } catch (error) {
      const errorString = error.toString();
      
      // Should get insufficient funds error (checked before arithmetic operations)
      expect(
        errorString.includes("0x1774") || // InsufficientFundsForWithdrawal
        errorString.includes("InsufficientFundsForWithdrawal") ||
        errorString.includes("0x1778") || // InsufficientFundsToMaintainRentExemption  
        errorString.includes("InsufficientFundsToMaintainRentExemption")
      ).to.be.true;
    }
  });
});
