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
  let splTokenMint: anchor.web3.Keypair;
  let randomUserTokenAccount: anchor.web3.Keypair;
  let attackerTokenAccount: anchor.web3.Keypair;

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

    // Create a test SPL token mint
    splTokenMint = anchor.web3.Keypair.generate();
    const mintTx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.createAccount({
        fromPubkey: authority.publicKey,
        newAccountPubkey: splTokenMint.publicKey,
        space: 82, // Mint account size
        lamports: await provider.connection.getMinimumBalanceForRentExemption(82),
        programId: anchor.web3.TOKEN_PROGRAM_ID,
      }),
      anchor.web3.createInitializeMintInstruction(
        splTokenMint.publicKey,
        6, // decimals
        authority.publicKey,
        authority.publicKey
      )
    );
    
    await provider.sendAndConfirm(mintTx, [authority, splTokenMint]);
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

    // Create token accounts for signer and recipient
    const recipientTokenAccount = await anchor.web3.getAssociatedTokenAddress(
      splTokenMint.publicKey,
      recipient.publicKey
    );

    const feeRecipientTokenAccount = await anchor.web3.getAssociatedTokenAddress(
      splTokenMint.publicKey,
      FEE_RECIPIENT_ACCOUNT
    );

    // Create the token accounts
    const createRecipientTokenAccountTx = new anchor.web3.Transaction().add(
      anchor.web3.createAssociatedTokenAccountInstruction(
        authority.publicKey, // payer
        recipientTokenAccount, // associatedToken
        recipient.publicKey, // owner
        mint.publicKey // mint
      )
    );

    const createFeeRecipientTokenAccountTx = new anchor.web3.Transaction().add(
      anchor.web3.createAssociatedTokenAccountInstruction(
        authority.publicKey, // payer
        feeRecipientTokenAccount, // associatedToken
        FEE_RECIPIENT_ACCOUNT, // owner
        splTokenMint.publicKey // mint
      )
    );

    await provider.sendAndConfirm(createRecipientTokenAccountTx, [authority]);
    await provider.sendAndConfirm(createFeeRecipientTokenAccountTx, [authority]);

    // Mint tokens to token accounts
    const mintAmount = 1000000000000000000; // 1 token with 6 decimals
    const mintToRecipientTx = new anchor.web3.Transaction().add(
      anchor.web3.createMintToInstruction(
        splTokenMint.publicKey,
        recipientTokenAccount,
        authority.publicKey,
        mintAmount
      )
    );
    await provider.sendAndConfirm(mintToRecipientTx, [authority]);

    const mintToFeeRecipientTx = new anchor.web3.Transaction().add(
      anchor.web3.createMintToInstruction(
        splTokenMint.publicKey,
        feeRecipientTokenAccount,
        FEE_RECIPIENT_ACCOUNT,
        mintAmount
      )
    );
    await provider.sendAndConfirm(mintToFeeRecipientTx, [authority]);
      
    try {
      // Generate a random user for signing transactions
      randomUser = anchor.web3.Keypair.generate();
      randomUserTokenAccount = await anchor.web3.getAssociatedTokenAddress(
        splTokenMint.publicKey,
        randomUser.publicKey
      );

      attacker = anchor.web3.Keypair.generate();
      attackerTokenAccount = await anchor.web3.getAssociatedTokenAddress(
        splTokenMint.publicKey,
        attacker.publicKey
      );

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

      // create token accounts for random user and attacker
      const createRecipientTokenAccountTx = new anchor.web3.Transaction().add(
        anchor.web3.createAssociatedTokenAccountInstruction(
          authority.publicKey, // payer
          randomUserTokenAccount, // associatedToken
          recipient.publicKey, // owner
          splTokenMint.publicKey // mint
        )
      );
      await provider.sendAndConfirm(createRecipientTokenAccountTx, [authority]);
  
      const createFeeRecipientTokenAccountTx = new anchor.web3.Transaction().add(
        anchor.web3.createAssociatedTokenAccountInstruction(
          authority.publicKey, // payer
          attackerTokenAccount, // associatedToken
          feeRecipient.publicKey, // owner
          splTokenMint.publicKey // mint
        )
      );
      await provider.sendAndConfirm(createFeeRecipientTokenAccountTx, [authority]);

      // mint tokens to token accounts
      const mintToRandomUserTx = new anchor.web3.Transaction().add(
        anchor.web3.createMintToInstruction(
          splTokenMint.publicKey,
          randomUserTokenAccount,
          authority.publicKey,
          mintAmount
        )
      );
      await provider.sendAndConfirm(mintToRandomUserTx, [authority]);

      const mintToAttackerTx = new anchor.web3.Transaction().add(
        anchor.web3.createMintToInstruction(
          splTokenMint.publicKey,
          attackerTokenAccount,
          authority.publicKey,
          mintAmount
        )
      );
      await provider.sendAndConfirm(mintToAttackerTx, [authority]);

      // get token balances
      const randomUserTokenBalance = await provider.connection.getTokenAccountBalance(randomUserTokenAccount);
      const attackerTokenBalance = await provider.connection.getTokenAccountBalance(attackerTokenAccount);

      expect(randomUserTokenBalance.value.amount).to.be.equals(mintAmount);
      expect(attackerTokenBalance.value.amount).to.be.equals(mintAmount);
    } catch (error) {
      console.error("Error initializing accounts:", error);
      // Get more detailed error information if available
      if ('logs' in error) {
        console.error("Error logs:", error.logs);
      }
      throw error;
    }
  });

// ==================== SPL TOKEN TESTS ====================

it("Can execute SPL token deposit instruction for correct input", async () => {

    const depositAmount = 20000; // 0.02 tokens
    const calculatedDepositFee = calculateDepositFee(depositAmount);

    const extData = {
      recipient: recipient.publicKey,
      extAmount: new anchor.BN(depositAmount), // Positive ext amount (deposit)
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(calculatedDepositFee),
      feeRecipient: FEE_RECIPIENT_ACCOUNT,
      mintAddress: mint.publicKey, // SPL token mint address
    };

    // Create inputs for the deposit
    const inputs = [
      new Utxo({ lightWasm }),
      new Utxo({ lightWasm })
    ];

    const depositOutputs = [
      new Utxo({ 
        lightWasm, 
        amount: new anchor.BN(depositAmount),
        keypair: anchor.web3.Keypair.generate(),
        asset: mint.publicKey
      }),
      new Utxo({ 
        lightWasm, 
        amount: new anchor.BN(0),
        keypair: anchor.web3.Keypair.generate(),
        asset: mint.publicKey
      })
    ];

    const depositInput = {
      inputs,
      outputs: depositOutputs,
      extData,
      publicAmount: new anchor.BN(depositAmount),
      outPubkey: depositOutputs.map(x => x.keypair.pubkey),
    };

    const keyBasePath = path.resolve(__dirname, '../../artifacts/circuits/transaction2');
    const depositProofResult = await prove(depositInput, keyBasePath);
    const depositProofInBytes = parseProofToBytesArray(depositProofResult.proof);
    const depositInputsInBytes = parseToBytesArray(depositProofResult.publicSignals);

    const depositProofToSubmit = {
      proof: depositProofInBytes,
      publicSignals: depositInputsInBytes,
      inputNullifiers: [generateRandomNullifier(), generateRandomNullifier()],
      outputCommitments: depositOutputs.map(x => x.getCommitment(lightWasm)),
      publicAmount: depositInput.publicAmount,
      extDataHash: getExtDataHash(extData),
      root: globalMerkleTree.root,
    };

    const depositNullifiers = findNullifierPDAs(program, depositProofToSubmit);
    const depositCommitments = findCommitmentPDAs(program, depositProofToSubmit);

    // Create Address Lookup Table for deposit transaction
    const depositTestProtocolAddresses = getTestProtocolAddresses(
      program.programId,
      authority.publicKey,
      FEE_RECIPIENT_ACCOUNT
    );
    
    const depositLookupTableAddress = await createGlobalTestALT(provider.connection, authority, depositTestProtocolAddresses);

    // Get token balances before transaction
    const signerTokenBalanceBefore = await provider.connection.getTokenAccountBalance(signerTokenAccount);
    const recipientTokenBalanceBefore = await provider.connection.getTokenAccountBalance(recipientTokenAccount);

    // Execute SPL token deposit transaction
    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    const depositTx = await program.methods
      .transactSpl(depositProofToSubmit, createExtDataMinified(extData), extData.encryptedOutput1, extData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: depositNullifiers.nullifier0PDA,
        nullifier1: depositNullifiers.nullifier1PDA,
        nullifier2: depositNullifiers.nullifier2PDA,
        nullifier3: depositNullifiers.nullifier3PDA,
        commitment0: depositCommitments.commitment0PDA,
        commitment1: depositCommitments.commitment1PDA,
        treeTokenAccount: treeTokenAccountPDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey,
        mint: mint.publicKey,
        signerTokenAccount: signerTokenAccount,
        recipientTokenAccount: recipientTokenAccount,
        treeAta: await anchor.web3.getAssociatedTokenAddress(mint.publicKey, globalConfigPDA),
        feeRecipientAta: await anchor.web3.getAssociatedTokenAddress(mint.publicKey, FEE_RECIPIENT_ACCOUNT),
        tokenProgram: anchor.web3.TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.web3.ASSOCIATED_TOKEN_PROGRAM_ID,
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
    const depositTxSig = await sendAndConfirmVersionedTransaction(
      provider.connection,
      depositVersionedTx,
      [randomUser]
    );

    expect(depositTxSig).to.be.a('string');

    // Get token balances after transaction
    const signerTokenBalanceAfter = await provider.connection.getTokenAccountBalance(signerTokenAccount);
    const recipientTokenBalanceAfter = await provider.connection.getTokenAccountBalance(recipientTokenAccount);

    // Verify token balances
    const signerTokenDiff = signerTokenBalanceAfter.value.amount - signerTokenBalanceBefore.value.amount;
    const recipientTokenDiff = recipientTokenBalanceAfter.value.amount - recipientTokenBalanceBefore.value.amount;

    expect(signerTokenDiff).to.be.equals(-depositAmount); // Signer should have less tokens
    expect(recipientTokenDiff).to.be.equals(0); // Recipient should not receive tokens directly (they're in the tree)

    // Add commitments to the merkle tree
    for (const commitment of depositOutputs) {
      globalMerkleTree.insert(commitment.getCommitment(lightWasm));
    }
  });
});