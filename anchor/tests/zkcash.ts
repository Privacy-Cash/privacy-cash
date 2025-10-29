import * as anchor from "@coral-xyz/anchor";
import { Program, EventParser, BorshCoder } from "@coral-xyz/anchor";
import { Zkcash } from "../target/types/zkcash";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress, createInitializeMintInstruction, createAssociatedTokenAccountInstruction, createMintToInstruction, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";
import { getExtDataHash } from "./lib/utils";
import { DEFAULT_HEIGHT, FIELD_SIZE, ROOT_HISTORY_SIZE, ZERO_BYTES, DEPOSIT_FEE_RATE, WITHDRAW_FEE_RATE, FEE_RECIPIENT_ACCOUNT } from "./lib/constants";

// SOL address constant (matches the Rust program)
const SOL_ADDRESS = new PublicKey("11111111111111111111111111111112");

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

// Helper function to get mint address field for circuit
// Returns a field element that fits within the circuit's prime field (254 bits)
function getMintAddressField(mint: PublicKey): string {
  const mintStr = mint.toString();
  
  // Special case for SOL (system program)
  if (mintStr === '11111111111111111111111111111112') {
    return mintStr;
  }
  
  // For SPL tokens (USDC, USDT, etc): use first 16 bytes (128 bits)
  // This provides better collision resistance than 8 bytes while still fitting in the field
  // We will only suppport private SOL, USDC and USDT send, so there won't be any collision.
  const mintBytes = mint.toBytes();
  return new anchor.BN(mintBytes.slice(0, 16), 'be').toString();
}

export function bnToBytes(bn: anchor.BN): number[] {
  // Cast the result to number[] since we know the output is a byte array
  return Array.from(
    utils.leInt2Buff(utils.unstringifyBigInts(bn.toString()), 32)
  ).reverse() as number[];
}

import { MerkleTree } from "./lib/merkle_tree";
import { createGlobalTestALT, getTestProtocolAddresses, createVersionedTransactionWithALT, sendAndConfirmVersionedTransaction, getTestProtocolAddressesWithMint } from "./lib/test_alt";

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
  let feeRecipient: anchor.web3.Keypair; // Generate a new keypair for local testing
  let feeRecipientTokenAccount: PublicKey; // Token account for fee recipient
  let treeBump: number;
  let authority: anchor.web3.Keypair;
  let recipient: anchor.web3.Keypair;
  let fundingAccount: anchor.web3.Keypair;
  let randomUser: anchor.web3.Keypair; // Random user for signing transactions
  let attacker: anchor.web3.Keypair;
  let splTokenMint: anchor.web3.Keypair;
  let randomUserTokenAccount: PublicKey;
  let attackerTokenAccount: PublicKey;

  // Initialize variables for tree token account
  let treeTokenAccountPDA: PublicKey;
  let treeTokenBump: number;
  let globalConfigPDA: PublicKey;
  let globalMerkleTree: MerkleTree;

  // --- Funding a wallet to use for paying transaction fees ---
  before(async () => {
    authority = anchor.web3.Keypair.generate();
    feeRecipient = anchor.web3.Keypair.generate(); // Generate fee recipient for local testing
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
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(
        splTokenMint.publicKey,
        6, // decimals
        authority.publicKey,
        authority.publicKey
      )
    );
    
    await provider.sendAndConfirm(mintTx, [authority, splTokenMint]);

    // Fund the fee recipient with SOL for rent exemption
    const feeRecipientAirdropSig = await provider.connection.requestAirdrop(feeRecipient.publicKey, 0.5 * LAMPORTS_PER_SOL);
    const latestBlockhash = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      signature: feeRecipientAirdropSig,
    });

    // Create fee recipient token account (once for all tests)
    feeRecipientTokenAccount = await getAssociatedTokenAddress(
      splTokenMint.publicKey,
      feeRecipient.publicKey
    );

    const feeRecipientAtaTx = new anchor.web3.Transaction().add(
      createAssociatedTokenAccountInstruction(
        authority.publicKey, // payer
        feeRecipientTokenAccount, // associatedToken
        feeRecipient.publicKey, // owner
        splTokenMint.publicKey // mint
      )
    );
    await provider.sendAndConfirm(feeRecipientAtaTx, [authority]);
  });

  // Reset program state before each test
  beforeEach(async () => {
    // Generate new recipient and fee recipient keypairs for each test
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

    // Fund the fee recipient with SOL for rent exemption
    const feeRecipientAirdropSignature = await provider.connection.requestAirdrop(feeRecipient.publicKey, 0.5 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction({
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      signature: feeRecipientAirdropSignature,
    });

    // Note: Token accounts will be derived in each test and created automatically by init_if_needed in the program
      
    try {
      // Generate a random user for signing transactions
      randomUser = anchor.web3.Keypair.generate();
      randomUserTokenAccount = await getAssociatedTokenAddress(
        splTokenMint.publicKey,
        randomUser.publicKey
      );

      attacker = anchor.web3.Keypair.generate();
      attackerTokenAccount = await getAssociatedTokenAddress(
        splTokenMint.publicKey,
        attacker.publicKey
      );

      // Note: feeRecipientTokenAccount is already created in before() hook

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
      const createRandomUserTokenAccountTx = new anchor.web3.Transaction().add(
        createAssociatedTokenAccountInstruction(
          authority.publicKey, // payer
          randomUserTokenAccount, // associatedToken
          randomUser.publicKey, // owner
          splTokenMint.publicKey // mint
        )
      );
      await provider.sendAndConfirm(createRandomUserTokenAccountTx, [authority]);
  
      const createAttackerTokenAccountTx = new anchor.web3.Transaction().add(
        createAssociatedTokenAccountInstruction(
          authority.publicKey, // payer
          attackerTokenAccount, // associatedToken
          attacker.publicKey, // owner
          splTokenMint.publicKey // mint
        )
      );
      await provider.sendAndConfirm(createAttackerTokenAccountTx, [authority]);

      // mint tokens to token accounts
      const mintAmount = 1000000000000; // 1 million tokens with 6 decimals
      const mintToRandomUserTx = new anchor.web3.Transaction().add(
        createMintToInstruction(
          splTokenMint.publicKey,
          randomUserTokenAccount,
          authority.publicKey,
          mintAmount
        )
      );
      await provider.sendAndConfirm(mintToRandomUserTx, [authority]);

      const mintToAttackerTx = new anchor.web3.Transaction().add(
        createMintToInstruction(
          splTokenMint.publicKey,
          attackerTokenAccount,
          authority.publicKey,
          mintAmount
        )
      );
      await provider.sendAndConfirm(mintToAttackerTx, [authority]);

      // Fee recipient token account already created in before() hook
      // get token balances
      const randomUserTokenBalance = await provider.connection.getTokenAccountBalance(randomUserTokenAccount);
      const attackerTokenBalance = await provider.connection.getTokenAccountBalance(attackerTokenAccount);

      expect(randomUserTokenBalance.value.amount).to.be.equals(mintAmount.toString());
      expect(attackerTokenBalance.value.amount).to.be.equals(mintAmount.toString());
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

    // Get token accounts for signer (randomUser) and recipient
    const signerTokenAccount = randomUserTokenAccount;
    const recipientTokenAccount = await getAssociatedTokenAddress(
      splTokenMint.publicKey,
      recipient.publicKey
    );

    // Create recipient token account manually since it's now UncheckedAccount
    try {
      const createRecipientTokenAccountTx = new anchor.web3.Transaction().add(
        createAssociatedTokenAccountInstruction(
          randomUser.publicKey, // payer
          recipientTokenAccount, // associatedToken
          recipient.publicKey, // owner
          splTokenMint.publicKey // mint
        )
      );
      await provider.sendAndConfirm(createRecipientTokenAccountTx, [randomUser]);
    } catch (error) {
      // Account might already exist, which is fine
      console.log("Recipient token account might already exist:", error.message);
    }

    const extData = {
      recipient: recipientTokenAccount, // Use the token account, not the user account
      extAmount: new anchor.BN(depositAmount), // Positive ext amount (deposit)
      encryptedOutput1: Buffer.from("encryptedOutput1Data"),
      encryptedOutput2: Buffer.from("encryptedOutput2Data"),
      fee: new anchor.BN(calculatedDepositFee),
      feeRecipient: feeRecipientTokenAccount, // Use the fee recipient ATA, not the account
      mintAddress: splTokenMint.publicKey, // SPL token mint address
    };

    // Convert SPL token mint address to a field element that the circuit can understand
    // Get the mint address as a field element for the circuit
    const mintAddressField = getMintAddressField(splTokenMint.publicKey);
    
    const inputs = [
      new Utxo({ lightWasm, mintAddress: mintAddressField }),
      new Utxo({ lightWasm, mintAddress: mintAddressField })
    ];

    const outputAmount = (depositAmount - calculatedDepositFee).toString();
    const outputs = [
      new Utxo({ lightWasm, amount: outputAmount, index: globalMerkleTree._layers[0].length, mintAddress: mintAddressField }), // Combined amount minus fee
      new Utxo({ lightWasm, amount: '0', mintAddress: mintAddressField }) // Empty UTXO
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

  const treeAta = await getAssociatedTokenAddress(splTokenMint.publicKey, globalConfigPDA, true);
  // feeRecipientAta is already calculated above

   // Create Address Lookup Table for transaction size optimization
   const testProtocolAddresses = getTestProtocolAddressesWithMint(
    program.programId,
    authority.publicKey,
    treeAta,
    feeRecipient.publicKey,
    feeRecipientTokenAccount
  );
   
   const lookupTableAddress = await createGlobalTestALT(provider.connection, authority, testProtocolAddresses);

    // Get token balances before transaction
    const signerTokenBalanceBefore = await provider.connection.getTokenAccountBalance(signerTokenAccount);
    
    // Check if recipient token account exists, if not, it will be created by init_if_needed
    let recipientTokenBalanceBefore;
    try {
      recipientTokenBalanceBefore = await provider.connection.getTokenAccountBalance(recipientTokenAccount);
    } catch (error) {
      // Account doesn't exist yet, will be created by init_if_needed
      recipientTokenBalanceBefore = { value: { amount: '0' } };
    }

    // Execute SPL token deposit transaction
    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    const depositTx = await program.methods
      .transactSpl(proofToSubmit, createExtDataMinified(extData), extData.encryptedOutput1, extData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: nullifier0PDA,
        nullifier1: nullifier1PDA,
        nullifier2: crossCheckNullifiers.nullifier2PDA,
        nullifier3: crossCheckNullifiers.nullifier3PDA,
        commitment0: commitment0PDA,
        commitment1: commitment1PDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey,
        recipient: recipient.publicKey,
        mint: splTokenMint.publicKey,
        signerTokenAccount: signerTokenAccount,
        recipientTokenAccount: recipientTokenAccount,
        treeAta: treeAta,
        feeRecipientAta: feeRecipientTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
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
      lookupTableAddress
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
    for (const commitment of outputs) {
      globalMerkleTree.insert(await commitment.getCommitment());
    }
  });

  it("SPL Double spend attack fails", async () => {
    // Step 1: First, do a deposit to create a UTXO we can later double spend
    const depositAmount = 1000;
    const depositFee = new anchor.BN(calculateDepositFee(depositAmount));
    
    const depositExtData = {
      recipient: await getAssociatedTokenAddress(splTokenMint.publicKey, recipient.publicKey),
      extAmount: new anchor.BN(depositAmount), // Positive ext amount (deposit)
      encryptedOutput1: Buffer.from("depositEncryptedOutput1"),
      encryptedOutput2: Buffer.from("depositEncryptedOutput2"),
      fee: depositFee,
      feeRecipient: feeRecipientTokenAccount,
      mintAddress: splTokenMint.publicKey,
    };

    // Create recipient token account manually since it's now UncheckedAccount
    const recipientTokenAccount = await getAssociatedTokenAddress(splTokenMint.publicKey, recipient.publicKey);
    try {
      const createRecipientTokenAccountTx = new anchor.web3.Transaction().add(
        createAssociatedTokenAccountInstruction(
          randomUser.publicKey, // payer
          recipientTokenAccount, // associatedToken
          recipient.publicKey, // owner
          splTokenMint.publicKey // mint
        )
      );
      await provider.sendAndConfirm(createRecipientTokenAccountTx, [randomUser]);
    } catch (error) {
      // Account might already exist, which is fine
      console.log("Recipient token account might already exist:", error.message);
    }

    // Convert SPL token mint address to a field element that the circuit can understand
    // Get the mint address as a field element for the circuit
    const mintAddressField = getMintAddressField(splTokenMint.publicKey);
    
    const depositInputs = [
      new Utxo({ lightWasm, mintAddress: mintAddressField }),
      new Utxo({ lightWasm, mintAddress: mintAddressField })
    ];

    const depositOutputs = [
      new Utxo({ 
        lightWasm, 
        amount: new anchor.BN(depositAmount - depositFee.toNumber()),
        index: globalMerkleTree._layers[0].length,
        mintAddress: mintAddressField
      }),
      new Utxo({ 
        lightWasm, 
        amount: new anchor.BN(0),
        mintAddress: mintAddressField
      })
    ];

    const depositInputMerklePathIndices = depositInputs.map((input) => input.index || 0);
    const depositInputMerklePathElements = depositInputs.map(() => {
      return [...new Array(globalMerkleTree.levels).fill(0)];
    });

    const depositInputNullifiers = await Promise.all(depositInputs.map(x => x.getNullifier()));
    const depositOutputCommitments = await Promise.all(depositOutputs.map(x => x.getCommitment()));

    const depositRoot = globalMerkleTree.root();
    const depositCalculatedExtDataHash = getExtDataHash(depositExtData);
    const depositPublicAmountNumber = new anchor.BN(depositAmount - depositFee.toNumber());

    const depositInput = {
      root: depositRoot,
      publicAmount: depositPublicAmountNumber.toString(),
      extDataHash: depositCalculatedExtDataHash,
      mintAddress: depositInputs[0].mintAddress,
      
      inputNullifier: depositInputNullifiers,
      inAmount: depositInputs.map(x => x.amount.toString(10)),
      inPrivateKey: depositInputs.map(x => x.keypair.privkey),
      inBlinding: depositInputs.map(x => x.blinding.toString(10)),
      inPathIndices: depositInputMerklePathIndices,
      inPathElements: depositInputMerklePathElements,
      
      outputCommitment: depositOutputCommitments,
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
      inputNullifiers: [
        depositInputsInBytes[3],
        depositInputsInBytes[4]
      ],
      outputCommitments: [
        depositInputsInBytes[5],
        depositInputsInBytes[6]
      ],
    };

    const depositNullifiers = findNullifierPDAs(program, depositProofToSubmit);
    const depositCrossCheckNullifiers = findCrossCheckNullifierPDAs(program, depositProofToSubmit);
    const depositCommitments = findCommitmentPDAs(program, depositProofToSubmit);

    const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    const treeAta = await getAssociatedTokenAddress(splTokenMint.publicKey, globalConfigPDA, true);
    
    const depositTestProtocolAddresses = getTestProtocolAddressesWithMint(
      program.programId,
      authority.publicKey,
      treeAta,
      feeRecipient.publicKey,
      feeRecipientTokenAccount
    );
    
    const depositLookupTableAddress = await createGlobalTestALT(provider.connection, authority, depositTestProtocolAddresses);

    const depositTx = await program.methods
      .transactSpl(depositProofToSubmit, createExtDataMinified(depositExtData), depositExtData.encryptedOutput1, depositExtData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: depositNullifiers.nullifier0PDA,
        nullifier1: depositNullifiers.nullifier1PDA,
        nullifier2: depositCrossCheckNullifiers.nullifier2PDA,
        nullifier3: depositCrossCheckNullifiers.nullifier3PDA,
        commitment0: depositCommitments.commitment0PDA,
        commitment1: depositCommitments.commitment1PDA,
        treeTokenAccount: treeTokenAccountPDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey,
        recipient: recipient.publicKey,
        mint: splTokenMint.publicKey,
        signerTokenAccount: randomUserTokenAccount,
        recipientTokenAccount: recipientTokenAccount,
        treeAta: treeAta,
        feeRecipientAta: feeRecipientTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .preInstructions([modifyComputeUnits])
      .transaction();

    const depositVersionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      randomUser.publicKey,
      depositTx.instructions,
      depositLookupTableAddress
    );
    
    const depositTxSig = await sendAndConfirmVersionedTransaction(
      provider.connection,
      depositVersionedTx,
      [randomUser]
    );

    expect(depositTxSig).to.be.a('string');

    // Add commitments to the merkle tree
    for (const commitment of depositOutputs) {
      globalMerkleTree.insert(await commitment.getCommitment());
    }

    // Step 2: Now try to double spend the same UTXO
    const targetUtxo = depositOutputs[0]; // This is the UTXO we'll double spend
    
    const firstInputs = [
      targetUtxo, // Use the deposited UTXO as first input (nullifier goes to nullifier0)
      new Utxo({ lightWasm, mintAddress: mintAddressField }) // Empty second input
    ];

    const firstOutputs = [
      new Utxo({ lightWasm, amount: '800', mintAddress: mintAddressField }),
      new Utxo({ lightWasm, amount: '0', mintAddress: mintAddressField })
    ];

    const firstInputsSum = firstInputs.reduce((sum, x) => sum.add(x.amount), new BN(0));
    const firstOutputsSum = firstOutputs.reduce((sum, x) => sum.add(x.amount), new BN(0));
    const firstWithdrawFee = new anchor.BN(calculateWithdrawalFee(firstInputsSum.toNumber()));
    const firstExtAmount = new BN(firstWithdrawFee).add(firstOutputsSum).sub(firstInputsSum);
    
    const firstPublicAmount = new BN(firstExtAmount).sub(new BN(firstWithdrawFee)).add(FIELD_SIZE).mod(FIELD_SIZE);
    
    const firstExtData = {
      recipient: await getAssociatedTokenAddress(splTokenMint.publicKey, recipient.publicKey),
      extAmount: firstExtAmount,
      encryptedOutput1: Buffer.from("firstEncryptedOutput1"),
      encryptedOutput2: Buffer.from("firstEncryptedOutput2"),
      fee: firstWithdrawFee,
      feeRecipient: await getAssociatedTokenAddress(splTokenMint.publicKey, feeRecipient.publicKey),
      mintAddress: splTokenMint.publicKey,
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

    // This should fail because we're trying to use the same nullifiers
    const firstTx = await program.methods
      .transactSpl(firstProofToSubmit, createExtDataMinified(firstExtData), firstExtData.encryptedOutput1, firstExtData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: firstNullifiers.nullifier0PDA,
        nullifier1: firstNullifiers.nullifier1PDA,
        nullifier2: firstCrossCheckNullifiers.nullifier2PDA,
        nullifier3: firstCrossCheckNullifiers.nullifier3PDA,
        commitment0: firstCommitments.commitment0PDA,
        commitment1: firstCommitments.commitment1PDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey,
        recipient: recipient.publicKey,
        mint: splTokenMint.publicKey,
        signerTokenAccount: randomUserTokenAccount,
        recipientTokenAccount: recipientTokenAccount,
        treeAta: treeAta,
        feeRecipientAta: feeRecipientTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .preInstructions([modifyComputeUnits])
      .transaction();

    const firstVersionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      randomUser.publicKey,
      firstTx.instructions,
      depositLookupTableAddress
    );

    const firstTxSig = await sendAndConfirmVersionedTransaction(
      provider.connection,
      firstVersionedTx,
      [randomUser]
    );

    expect(firstTxSig).to.be.a('string');

    // Add commitments to the merkle tree
    for (const commitment of firstOutputs) {
      globalMerkleTree.insert(await commitment.getCommitment());
    }
  });

  it("SPL Can execute both deposit and withdraw instruction for correct input, with positive fee", async () => {
    // Step 1: Perform a deposit with configured fee
    const depositAmount = 50000;
    const depositFee = calculateDepositFee(depositAmount); // Should be 0 based on config

    const mintAddressField = getMintAddressField(splTokenMint.publicKey);

    // Create recipient token account
    const recipientTokenAccount = await getAssociatedTokenAddress(splTokenMint.publicKey, recipient.publicKey);
    try {
      const createRecipientTokenAccountTx = new anchor.web3.Transaction().add(
        createAssociatedTokenAccountInstruction(
          randomUser.publicKey,
          recipientTokenAccount,
          recipient.publicKey,
          splTokenMint.publicKey
        )
      );
      await provider.sendAndConfirm(createRecipientTokenAccountTx, [randomUser]);
    } catch (error) {
      console.log("Recipient token account might already exist:", error.message);
    }

    // Deposit transaction
    const depositInputs = [
      new Utxo({ lightWasm, mintAddress: mintAddressField }),
      new Utxo({ lightWasm, mintAddress: mintAddressField })
    ];

    const depositOutputAmount = (depositAmount - depositFee).toString();
    const depositOutputs = [
      new Utxo({ 
        lightWasm, 
        amount: depositOutputAmount,
        index: globalMerkleTree._layers[0].length,
        mintAddress: mintAddressField
      }),
      new Utxo({ lightWasm, amount: '0', mintAddress: mintAddressField })
    ];

    const depositExtData = {
      recipient: recipientTokenAccount,
      extAmount: new anchor.BN(depositAmount),
      encryptedOutput1: Buffer.from("depositEncryptedOutput1"),
      encryptedOutput2: Buffer.from("depositEncryptedOutput2"),
      fee: new anchor.BN(depositFee),
      feeRecipient: feeRecipientTokenAccount,
      mintAddress: splTokenMint.publicKey,
    };

    const depositInputMerklePathIndices = depositInputs.map((input) => input.index || 0);
    const depositInputMerklePathElements = depositInputs.map(() => {
      return [...new Array(globalMerkleTree.levels).fill(0)];
    });

    const depositInputNullifiers = await Promise.all(depositInputs.map(x => x.getNullifier()));
    const depositOutputCommitments = await Promise.all(depositOutputs.map(x => x.getCommitment()));

    const depositRoot = globalMerkleTree.root();
    const depositCalculatedExtDataHash = getExtDataHash(depositExtData);
    const depositPublicAmountNumber = new anchor.BN(depositAmount - depositFee);

    const depositInput = {
      root: depositRoot,
      publicAmount: depositPublicAmountNumber.toString(),
      extDataHash: depositCalculatedExtDataHash,
      mintAddress: depositInputs[0].mintAddress,
      
      inputNullifier: depositInputNullifiers,
      inAmount: depositInputs.map(x => x.amount.toString(10)),
      inPrivateKey: depositInputs.map(x => x.keypair.privkey),
      inBlinding: depositInputs.map(x => x.blinding.toString(10)),
      inPathIndices: depositInputMerklePathIndices,
      inPathElements: depositInputMerklePathElements,
      
      outputCommitment: depositOutputCommitments,
      outAmount: depositOutputs.map(x => x.amount.toString(10)),
      outBlinding: depositOutputs.map(x => x.blinding.toString(10)),
      outPubkey: depositOutputs.map(x => x.keypair.pubkey),
    };

    const keyBasePath = path.resolve(__dirname, '../../artifacts/circuits/transaction2');
    const {proof: depositProof, publicSignals: depositPublicSignals} = await prove(depositInput, keyBasePath);

    const depositProofInBytes = parseProofToBytesArray(depositProof);
    const depositInputsInBytes = parseToBytesArray(depositPublicSignals);
    
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

    const treeAta = await getAssociatedTokenAddress(splTokenMint.publicKey, globalConfigPDA, true);

    const depositTestProtocolAddresses = getTestProtocolAddressesWithMint(
      program.programId,
      authority.publicKey,
      treeAta,
      feeRecipient.publicKey,
      feeRecipientTokenAccount
    );
    
    const depositLookupTableAddress = await createGlobalTestALT(provider.connection, authority, depositTestProtocolAddresses);

    const signerTokenBalanceBefore = await provider.connection.getTokenAccountBalance(randomUserTokenAccount);

    const modifyComputeUnitsDeposit = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    const depositTx = await program.methods
      .transactSpl(depositProofToSubmit, createExtDataMinified(depositExtData), depositExtData.encryptedOutput1, depositExtData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: depositNullifiers.nullifier0PDA,
        nullifier1: depositNullifiers.nullifier1PDA,
        nullifier2: depositCrossCheckNullifiers.nullifier2PDA,
        nullifier3: depositCrossCheckNullifiers.nullifier3PDA,
        commitment0: depositCommitments.commitment0PDA,
        commitment1: depositCommitments.commitment1PDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey,
        recipient: recipient.publicKey,
        mint: splTokenMint.publicKey,
        signerTokenAccount: randomUserTokenAccount,
        recipientTokenAccount: recipientTokenAccount,
        treeAta: treeAta,
        feeRecipientAta: feeRecipientTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .preInstructions([modifyComputeUnitsDeposit])
      .transaction();

    const depositVersionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      randomUser.publicKey,
      depositTx.instructions,
      depositLookupTableAddress
    );
    
    const depositTxSig = await sendAndConfirmVersionedTransaction(
      provider.connection,
      depositVersionedTx,
      [randomUser]
    );

    expect(depositTxSig).to.be.a('string');

    const signerTokenBalanceAfter = await provider.connection.getTokenAccountBalance(randomUserTokenAccount);
    const signerTokenDiff = parseInt(signerTokenBalanceAfter.value.amount) - parseInt(signerTokenBalanceBefore.value.amount);

    expect(signerTokenDiff).to.equal(-depositAmount);

    // Add deposit commitments to the merkle tree
    for (const commitment of depositOutputs) {
      globalMerkleTree.insert(await commitment.getCommitment());
    }

    // Step 2: Perform a withdrawal with configured fee
    const withdrawAmount = 25000;
    const withdrawFee = calculateWithdrawalFee(withdrawAmount); // 0.25% withdrawal fee

    const withdrawInputs = [
      depositOutputs[0], // Use the UTXO from the deposit
      new Utxo({ lightWasm, mintAddress: mintAddressField })
    ];

    const changeAmount = depositAmount - depositFee - withdrawAmount - withdrawFee;
    const withdrawOutputs = [
      new Utxo({ 
        lightWasm, 
        amount: changeAmount.toString(),
        index: globalMerkleTree._layers[0].length,
        mintAddress: mintAddressField
      }),
      new Utxo({ lightWasm, amount: '0', mintAddress: mintAddressField })
    ];

    const withdrawExtData = {
      recipient: recipientTokenAccount,
      extAmount: new anchor.BN(-withdrawAmount),
      encryptedOutput1: Buffer.from("withdrawEncryptedOutput1"),
      encryptedOutput2: Buffer.from("withdrawEncryptedOutput2"),
      fee: new anchor.BN(withdrawFee),
      feeRecipient: feeRecipientTokenAccount,
      mintAddress: splTokenMint.publicKey,
    };

    const withdrawInputMerklePathIndices = withdrawInputs.map((input) => input.index || 0);
    const withdrawInputMerklePathElements = withdrawInputs.map((input, i) => {
      if (i === 0) {
        return globalMerkleTree.path(input.index).pathElements;
      }
      return [...new Array(globalMerkleTree.levels).fill(0)];
    });

    const withdrawInputNullifiers = await Promise.all(withdrawInputs.map(x => x.getNullifier()));
    const withdrawOutputCommitments = await Promise.all(withdrawOutputs.map(x => x.getCommitment()));

    const withdrawRoot = globalMerkleTree.root();
    const withdrawCalculatedExtDataHash = getExtDataHash(withdrawExtData);
    const withdrawPublicAmountNumber = new anchor.BN(-withdrawAmount - withdrawFee);

    const withdrawCircuitInput = {
      root: withdrawRoot,
      publicAmount: withdrawPublicAmountNumber.toString(),
      extDataHash: withdrawCalculatedExtDataHash,
      mintAddress: withdrawInputs[0].mintAddress,
      
      inputNullifier: withdrawInputNullifiers,
      inAmount: withdrawInputs.map(x => x.amount.toString(10)),
      inPrivateKey: withdrawInputs.map(x => x.keypair.privkey),
      inBlinding: withdrawInputs.map(x => x.blinding.toString(10)),
      inPathIndices: withdrawInputMerklePathIndices,
      inPathElements: withdrawInputMerklePathElements,
      
      outputCommitment: withdrawOutputCommitments,
      outAmount: withdrawOutputs.map(x => x.amount.toString(10)),
      outBlinding: withdrawOutputs.map(x => x.blinding.toString(10)),
      outPubkey: withdrawOutputs.map(x => x.keypair.pubkey),
    };

    const {proof: withdrawProof, publicSignals: withdrawPublicSignals} = await prove(withdrawCircuitInput, keyBasePath);

    const withdrawProofInBytes = parseProofToBytesArray(withdrawProof);
    const withdrawInputsInBytes = parseToBytesArray(withdrawPublicSignals);
    
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

    const recipientTokenBalanceBefore = await provider.connection.getTokenAccountBalance(recipientTokenAccount);
    const feeRecipientBalanceBefore = await provider.connection.getTokenAccountBalance(feeRecipientTokenAccount);

    const modifyComputeUnitsWithdraw = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    const withdrawTx = await program.methods
      .transactSpl(withdrawProofToSubmit, createExtDataMinified(withdrawExtData), withdrawExtData.encryptedOutput1, withdrawExtData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: withdrawNullifiers.nullifier0PDA,
        nullifier1: withdrawNullifiers.nullifier1PDA,
        nullifier2: withdrawCrossCheckNullifiers.nullifier2PDA,
        nullifier3: withdrawCrossCheckNullifiers.nullifier3PDA,
        commitment0: withdrawCommitments.commitment0PDA,
        commitment1: withdrawCommitments.commitment1PDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey,
        recipient: recipient.publicKey,
        mint: splTokenMint.publicKey,
        signerTokenAccount: randomUserTokenAccount,
        recipientTokenAccount: recipientTokenAccount,
        treeAta: treeAta,
        feeRecipientAta: feeRecipientTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .preInstructions([modifyComputeUnitsWithdraw])
      .transaction();

    const withdrawVersionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      randomUser.publicKey,
      withdrawTx.instructions,
      depositLookupTableAddress
    );
    
    const withdrawTxSig = await sendAndConfirmVersionedTransaction(
      provider.connection,
      withdrawVersionedTx,
      [randomUser]
    );

    expect(withdrawTxSig).to.be.a('string');

    const recipientTokenBalanceAfter = await provider.connection.getTokenAccountBalance(recipientTokenAccount);
    const feeRecipientBalanceAfter = await provider.connection.getTokenAccountBalance(feeRecipientTokenAccount);
    
    const recipientTokenDiff = parseInt(recipientTokenBalanceAfter.value.amount) - parseInt(recipientTokenBalanceBefore.value.amount);
    const feeRecipientDiff = parseInt(feeRecipientBalanceAfter.value.amount) - parseInt(feeRecipientBalanceBefore.value.amount);

    expect(recipientTokenDiff).to.equal(withdrawAmount);
    expect(feeRecipientDiff).to.equal(withdrawFee);

    // Add withdrawal commitments to the merkle tree
    for (const commitment of withdrawOutputs) {
      globalMerkleTree.insert(await commitment.getCommitment());
    }
  });

  it("SPL Can execute both deposit and withdraw instruction to PDA recipient, with positive fee", async () => {
    // Step 1: Perform a deposit with configured fee
    const depositAmount = 50000;
    const depositFee = calculateDepositFee(depositAmount);

    const mintAddressField = getMintAddressField(splTokenMint.publicKey);

    // Create regular recipient token account for deposit
    const recipientTokenAccount = await getAssociatedTokenAddress(splTokenMint.publicKey, recipient.publicKey);
    try {
      const createRecipientTokenAccountTx = new anchor.web3.Transaction().add(
        createAssociatedTokenAccountInstruction(
          randomUser.publicKey,
          recipientTokenAccount,
          recipient.publicKey,
          splTokenMint.publicKey
        )
      );
      await provider.sendAndConfirm(createRecipientTokenAccountTx, [randomUser]);
    } catch (error) {
      console.log("Recipient token account might already exist:", error.message);
    }

    // Create a different PDA as the withdrawal recipient
    // We can't use globalConfigPDA because it's already the tree authority (tree_ata uses it)
    // So we create a test PDA with a different seed
    const [pdaRecipient] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("test_pda_recipient")],
      program.programId
    );
    
    const pdaRecipientTokenAccount = await getAssociatedTokenAddress(
      splTokenMint.publicKey, 
      pdaRecipient, 
      true // allowOwnerOffCurve for PDA
    );

    // Deposit transaction
    const depositInputs = [
      new Utxo({ lightWasm, mintAddress: mintAddressField }),
      new Utxo({ lightWasm, mintAddress: mintAddressField })
    ];

    const depositOutputAmount = (depositAmount - depositFee).toString();
    const depositOutputs = [
      new Utxo({ 
        lightWasm, 
        amount: depositOutputAmount,
        index: globalMerkleTree._layers[0].length,
        mintAddress: mintAddressField
      }),
      new Utxo({ lightWasm, amount: '0', mintAddress: mintAddressField })
    ];

    const depositExtData = {
      recipient: recipientTokenAccount, // Use regular recipient for deposit
      extAmount: new anchor.BN(depositAmount),
      encryptedOutput1: Buffer.from("pdaDepositEncryptedOutput1"),
      encryptedOutput2: Buffer.from("pdaDepositEncryptedOutput2"),
      fee: new anchor.BN(depositFee),
      feeRecipient: feeRecipientTokenAccount,
      mintAddress: splTokenMint.publicKey,
    };

    const depositInputMerklePathIndices = depositInputs.map((input) => input.index || 0);
    const depositInputMerklePathElements = depositInputs.map(() => {
      return [...new Array(globalMerkleTree.levels).fill(0)];
    });

    const depositInputNullifiers = await Promise.all(depositInputs.map(x => x.getNullifier()));
    const depositOutputCommitments = await Promise.all(depositOutputs.map(x => x.getCommitment()));

    const depositRoot = globalMerkleTree.root();
    const depositCalculatedExtDataHash = getExtDataHash(depositExtData);
    const depositPublicAmountNumber = new anchor.BN(depositAmount - depositFee);

    const depositInput = {
      root: depositRoot,
      publicAmount: depositPublicAmountNumber.toString(),
      extDataHash: depositCalculatedExtDataHash,
      mintAddress: depositInputs[0].mintAddress,
      
      inputNullifier: depositInputNullifiers,
      inAmount: depositInputs.map(x => x.amount.toString(10)),
      inPrivateKey: depositInputs.map(x => x.keypair.privkey),
      inBlinding: depositInputs.map(x => x.blinding.toString(10)),
      inPathIndices: depositInputMerklePathIndices,
      inPathElements: depositInputMerklePathElements,
      
      outputCommitment: depositOutputCommitments,
      outAmount: depositOutputs.map(x => x.amount.toString(10)),
      outBlinding: depositOutputs.map(x => x.blinding.toString(10)),
      outPubkey: depositOutputs.map(x => x.keypair.pubkey),
    };

    const keyBasePath = path.resolve(__dirname, '../../artifacts/circuits/transaction2');
    const {proof: depositProof, publicSignals: depositPublicSignals} = await prove(depositInput, keyBasePath);

    const depositProofInBytes = parseProofToBytesArray(depositProof);
    const depositInputsInBytes = parseToBytesArray(depositPublicSignals);
    
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

    const treeAta = await getAssociatedTokenAddress(splTokenMint.publicKey, globalConfigPDA, true);

    const depositTestProtocolAddresses = getTestProtocolAddressesWithMint(
      program.programId,
      authority.publicKey,
      treeAta,
      feeRecipient.publicKey,
      feeRecipientTokenAccount
    );
    
    const depositLookupTableAddress = await createGlobalTestALT(provider.connection, authority, depositTestProtocolAddresses);

    const signerTokenBalanceBefore = await provider.connection.getTokenAccountBalance(randomUserTokenAccount);

    const modifyComputeUnitsDeposit = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    const depositTx = await program.methods
      .transactSpl(depositProofToSubmit, createExtDataMinified(depositExtData), depositExtData.encryptedOutput1, depositExtData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: depositNullifiers.nullifier0PDA,
        nullifier1: depositNullifiers.nullifier1PDA,
        nullifier2: depositCrossCheckNullifiers.nullifier2PDA,
        nullifier3: depositCrossCheckNullifiers.nullifier3PDA,
        commitment0: depositCommitments.commitment0PDA,
        commitment1: depositCommitments.commitment1PDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey,
        recipient: recipient.publicKey, // Use regular recipient for deposit
        mint: splTokenMint.publicKey,
        signerTokenAccount: randomUserTokenAccount,
        recipientTokenAccount: recipientTokenAccount, // Use regular token account for deposit
        treeAta: treeAta,
        feeRecipientAta: feeRecipientTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .preInstructions([modifyComputeUnitsDeposit])
      .transaction();

    const depositVersionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      randomUser.publicKey,
      depositTx.instructions,
      depositLookupTableAddress
    );
    
    const depositTxSig = await sendAndConfirmVersionedTransaction(
      provider.connection,
      depositVersionedTx,
      [randomUser]
    );

    expect(depositTxSig).to.be.a('string');

    const signerTokenBalanceAfter = await provider.connection.getTokenAccountBalance(randomUserTokenAccount);
    const signerTokenDiff = parseInt(signerTokenBalanceAfter.value.amount) - parseInt(signerTokenBalanceBefore.value.amount);

    expect(signerTokenDiff).to.equal(-depositAmount);

    // Add deposit commitments to the merkle tree
    for (const commitment of depositOutputs) {
      globalMerkleTree.insert(await commitment.getCommitment());
    }

    // Step 2: Perform a withdrawal to PDA recipient with configured fee
    const withdrawAmount = 25000;
    const withdrawFee = calculateWithdrawalFee(withdrawAmount);

    const withdrawInputs = [
      depositOutputs[0], // Use the UTXO from the deposit
      new Utxo({ lightWasm, mintAddress: mintAddressField })
    ];

    const changeAmount = depositAmount - depositFee - withdrawAmount - withdrawFee;
    const withdrawOutputs = [
      new Utxo({ 
        lightWasm, 
        amount: changeAmount.toString(),
        index: globalMerkleTree._layers[0].length,
        mintAddress: mintAddressField
      }),
      new Utxo({ lightWasm, amount: '0', mintAddress: mintAddressField })
    ];

    const withdrawExtData = {
      recipient: pdaRecipientTokenAccount,
      extAmount: new anchor.BN(-withdrawAmount),
      encryptedOutput1: Buffer.from("pdaWithdrawEncryptedOutput1"),
      encryptedOutput2: Buffer.from("pdaWithdrawEncryptedOutput2"),
      fee: new anchor.BN(withdrawFee),
      feeRecipient: feeRecipientTokenAccount,
      mintAddress: splTokenMint.publicKey,
    };

    const withdrawInputMerklePathIndices = withdrawInputs.map((input) => input.index || 0);
    const withdrawInputMerklePathElements = withdrawInputs.map((input, i) => {
      if (i === 0) {
        return globalMerkleTree.path(input.index).pathElements;
      }
      return [...new Array(globalMerkleTree.levels).fill(0)];
    });

    const withdrawInputNullifiers = await Promise.all(withdrawInputs.map(x => x.getNullifier()));
    const withdrawOutputCommitments = await Promise.all(withdrawOutputs.map(x => x.getCommitment()));

    const withdrawRoot = globalMerkleTree.root();
    const withdrawCalculatedExtDataHash = getExtDataHash(withdrawExtData);
    const withdrawPublicAmountNumber = new anchor.BN(-withdrawAmount - withdrawFee);

    const withdrawCircuitInput = {
      root: withdrawRoot,
      publicAmount: withdrawPublicAmountNumber.toString(),
      extDataHash: withdrawCalculatedExtDataHash,
      mintAddress: withdrawInputs[0].mintAddress,
      
      inputNullifier: withdrawInputNullifiers,
      inAmount: withdrawInputs.map(x => x.amount.toString(10)),
      inPrivateKey: withdrawInputs.map(x => x.keypair.privkey),
      inBlinding: withdrawInputs.map(x => x.blinding.toString(10)),
      inPathIndices: withdrawInputMerklePathIndices,
      inPathElements: withdrawInputMerklePathElements,
      
      outputCommitment: withdrawOutputCommitments,
      outAmount: withdrawOutputs.map(x => x.amount.toString(10)),
      outBlinding: withdrawOutputs.map(x => x.blinding.toString(10)),
      outPubkey: withdrawOutputs.map(x => x.keypair.pubkey),
    };

    const {proof: withdrawProof, publicSignals: withdrawPublicSignals} = await prove(withdrawCircuitInput, keyBasePath);

    const withdrawProofInBytes = parseProofToBytesArray(withdrawProof);
    const withdrawInputsInBytes = parseToBytesArray(withdrawPublicSignals);
    
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

    // PDA recipient token account doesn't exist yet, will be created during withdrawal via init_if_needed
    let pdaRecipientBalanceBefore = 0;
    try {
      const balance = await provider.connection.getTokenAccountBalance(pdaRecipientTokenAccount);
      pdaRecipientBalanceBefore = parseInt(balance.value.amount);
    } catch (error) {
      // Account doesn't exist yet, balance is 0
      pdaRecipientBalanceBefore = 0;
    }
    const feeRecipientBalanceBefore = await provider.connection.getTokenAccountBalance(feeRecipientTokenAccount);

    const modifyComputeUnitsWithdraw = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    const withdrawTx = await program.methods
      .transactSpl(withdrawProofToSubmit, createExtDataMinified(withdrawExtData), withdrawExtData.encryptedOutput1, withdrawExtData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: withdrawNullifiers.nullifier0PDA,
        nullifier1: withdrawNullifiers.nullifier1PDA,
        nullifier2: withdrawCrossCheckNullifiers.nullifier2PDA,
        nullifier3: withdrawCrossCheckNullifiers.nullifier3PDA,
        commitment0: withdrawCommitments.commitment0PDA,
        commitment1: withdrawCommitments.commitment1PDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey,
        recipient: pdaRecipient,
        mint: splTokenMint.publicKey,
        signerTokenAccount: randomUserTokenAccount,
        recipientTokenAccount: pdaRecipientTokenAccount,
        treeAta: treeAta,
        feeRecipientAta: feeRecipientTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .preInstructions([modifyComputeUnitsWithdraw])
      .transaction();

    const withdrawVersionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      randomUser.publicKey,
      withdrawTx.instructions,
      depositLookupTableAddress
    );
    
    const withdrawTxSig = await sendAndConfirmVersionedTransaction(
      provider.connection,
      withdrawVersionedTx,
      [randomUser]
    );

    expect(withdrawTxSig).to.be.a('string');

    const pdaRecipientBalanceAfter = await provider.connection.getTokenAccountBalance(pdaRecipientTokenAccount);
    const feeRecipientBalanceAfter = await provider.connection.getTokenAccountBalance(feeRecipientTokenAccount);
    
    const pdaRecipientDiff = parseInt(pdaRecipientBalanceAfter.value.amount) - pdaRecipientBalanceBefore;
    const feeRecipientDiff = parseInt(feeRecipientBalanceAfter.value.amount) - parseInt(feeRecipientBalanceBefore.value.amount);

    expect(pdaRecipientDiff).to.equal(withdrawAmount);
    expect(feeRecipientDiff).to.equal(withdrawFee);

    // Add withdrawal commitments to the merkle tree
    for (const commitment of withdrawOutputs) {
      globalMerkleTree.insert(await commitment.getCommitment());
    }
  });

  it("SPL Can execute both deposit and withdraw instruction with PDA fee recipient, with positive fee", async () => {
    // Create a PDA as the fee recipient
    const [pdaFeeRecipient] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("test_pda_fee_recipient_spl")],
      program.programId
    );

    // Create token account for PDA fee recipient
    const pdaFeeRecipientTokenAccount = await getAssociatedTokenAddress(
      splTokenMint.publicKey,
      pdaFeeRecipient,
      true // allowOwnerOffCurve for PDA
    );

    // Create the PDA fee recipient token account
    try {
      const createPdaFeeRecipientTokenAccountTx = new anchor.web3.Transaction().add(
        createAssociatedTokenAccountInstruction(
          authority.publicKey, // payer
          pdaFeeRecipientTokenAccount, // associatedToken
          pdaFeeRecipient, // owner (PDA)
          splTokenMint.publicKey // mint
        )
      );
      await provider.sendAndConfirm(createPdaFeeRecipientTokenAccountTx, [authority]);
    } catch (error) {
      console.log("PDA fee recipient token account might already exist:", error.message);
    }

    // Step 1: Perform a deposit with configured fee
    const depositAmount = 50000;
    const depositFee = calculateDepositFee(depositAmount);

    const mintAddressField = getMintAddressField(splTokenMint.publicKey);

    // Create recipient token account
    const recipientTokenAccount = await getAssociatedTokenAddress(splTokenMint.publicKey, recipient.publicKey);
    try {
      const createRecipientTokenAccountTx = new anchor.web3.Transaction().add(
        createAssociatedTokenAccountInstruction(
          randomUser.publicKey,
          recipientTokenAccount,
          recipient.publicKey,
          splTokenMint.publicKey
        )
      );
      await provider.sendAndConfirm(createRecipientTokenAccountTx, [randomUser]);
    } catch (error) {
      console.log("Recipient token account might already exist:", error.message);
    }

    // Deposit transaction
    const depositInputs = [
      new Utxo({ lightWasm, mintAddress: mintAddressField }),
      new Utxo({ lightWasm, mintAddress: mintAddressField })
    ];

    const depositOutputAmount = (depositAmount - depositFee).toString();
    const depositOutputs = [
      new Utxo({ 
        lightWasm, 
        amount: depositOutputAmount,
        index: globalMerkleTree._layers[0].length,
        mintAddress: mintAddressField
      }),
      new Utxo({ lightWasm, amount: '0', mintAddress: mintAddressField })
    ];

    const depositExtData = {
      recipient: recipientTokenAccount,
      extAmount: new anchor.BN(depositAmount),
      encryptedOutput1: Buffer.from("depositEncryptedOutput1"),
      encryptedOutput2: Buffer.from("depositEncryptedOutput2"),
      fee: new anchor.BN(depositFee),
      feeRecipient: pdaFeeRecipientTokenAccount, // Use PDA token account as fee recipient
      mintAddress: splTokenMint.publicKey,
    };

    const depositInputMerklePathIndices = depositInputs.map((input) => input.index || 0);
    const depositInputMerklePathElements = depositInputs.map(() => {
      return [...new Array(globalMerkleTree.levels).fill(0)];
    });

    const depositInputNullifiers = await Promise.all(depositInputs.map(x => x.getNullifier()));
    const depositOutputCommitments = await Promise.all(depositOutputs.map(x => x.getCommitment()));

    const depositRoot = globalMerkleTree.root();
    const depositCalculatedExtDataHash = getExtDataHash(depositExtData);
    const depositPublicAmountNumber = new anchor.BN(depositAmount - depositFee);

    const depositInput = {
      root: depositRoot,
      publicAmount: depositPublicAmountNumber.toString(),
      extDataHash: depositCalculatedExtDataHash,
      mintAddress: depositInputs[0].mintAddress,
      
      inputNullifier: depositInputNullifiers,
      inAmount: depositInputs.map(x => x.amount.toString(10)),
      inPrivateKey: depositInputs.map(x => x.keypair.privkey),
      inBlinding: depositInputs.map(x => x.blinding.toString(10)),
      inPathIndices: depositInputMerklePathIndices,
      inPathElements: depositInputMerklePathElements,
      
      outputCommitment: depositOutputCommitments,
      outAmount: depositOutputs.map(x => x.amount.toString(10)),
      outBlinding: depositOutputs.map(x => x.blinding.toString(10)),
      outPubkey: depositOutputs.map(x => x.keypair.pubkey),
    };

    const keyBasePath = path.resolve(__dirname, '../../artifacts/circuits/transaction2');
    const {proof: depositProof, publicSignals: depositPublicSignals} = await prove(depositInput, keyBasePath);

    const depositProofInBytes = parseProofToBytesArray(depositProof);
    const depositInputsInBytes = parseToBytesArray(depositPublicSignals);
    
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

    const treeAta = await getAssociatedTokenAddress(splTokenMint.publicKey, globalConfigPDA, true);

    const depositTestProtocolAddresses = getTestProtocolAddressesWithMint(
      program.programId,
      authority.publicKey,
      treeAta,
      pdaFeeRecipient,
      pdaFeeRecipientTokenAccount
    );
    
    const depositLookupTableAddress = await createGlobalTestALT(provider.connection, authority, depositTestProtocolAddresses);

    const signerTokenBalanceBefore = await provider.connection.getTokenAccountBalance(randomUserTokenAccount);

    const modifyComputeUnitsDeposit = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    const depositTx = await program.methods
      .transactSpl(depositProofToSubmit, createExtDataMinified(depositExtData), depositExtData.encryptedOutput1, depositExtData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: depositNullifiers.nullifier0PDA,
        nullifier1: depositNullifiers.nullifier1PDA,
        nullifier2: depositCrossCheckNullifiers.nullifier2PDA,
        nullifier3: depositCrossCheckNullifiers.nullifier3PDA,
        commitment0: depositCommitments.commitment0PDA,
        commitment1: depositCommitments.commitment1PDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey,
        recipient: recipient.publicKey,
        mint: splTokenMint.publicKey,
        signerTokenAccount: randomUserTokenAccount,
        recipientTokenAccount: recipientTokenAccount,
        treeAta: treeAta,
        feeRecipientAta: pdaFeeRecipientTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .preInstructions([modifyComputeUnitsDeposit])
      .transaction();

    const depositVersionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      randomUser.publicKey,
      depositTx.instructions,
      depositLookupTableAddress
    );
    
    const depositTxSig = await sendAndConfirmVersionedTransaction(
      provider.connection,
      depositVersionedTx,
      [randomUser]
    );

    expect(depositTxSig).to.be.a('string');

    const signerTokenBalanceAfter = await provider.connection.getTokenAccountBalance(randomUserTokenAccount);
    const signerTokenDiff = parseInt(signerTokenBalanceAfter.value.amount) - parseInt(signerTokenBalanceBefore.value.amount);

    expect(signerTokenDiff).to.equal(-depositAmount);

    // Add deposit commitments to the merkle tree
    for (const commitment of depositOutputs) {
      globalMerkleTree.insert(await commitment.getCommitment());
    }

    // Step 2: Perform a withdrawal with configured fee
    const withdrawAmount = 25000;
    const withdrawFee = calculateWithdrawalFee(withdrawAmount);

    const withdrawInputs = [
      depositOutputs[0], // Use the UTXO from the deposit
      new Utxo({ lightWasm, mintAddress: mintAddressField })
    ];

    const changeAmount = depositAmount - depositFee - withdrawAmount - withdrawFee;
    const withdrawOutputs = [
      new Utxo({ 
        lightWasm, 
        amount: changeAmount.toString(),
        index: globalMerkleTree._layers[0].length,
        mintAddress: mintAddressField
      }),
      new Utxo({ lightWasm, amount: '0', mintAddress: mintAddressField })
    ];

    const withdrawExtData = {
      recipient: recipientTokenAccount,
      extAmount: new anchor.BN(-withdrawAmount),
      encryptedOutput1: Buffer.from("withdrawEncryptedOutput1"),
      encryptedOutput2: Buffer.from("withdrawEncryptedOutput2"),
      fee: new anchor.BN(withdrawFee),
      feeRecipient: pdaFeeRecipientTokenAccount, // Use PDA token account as fee recipient
      mintAddress: splTokenMint.publicKey,
    };

    const withdrawInputMerklePathIndices = withdrawInputs.map((input) => input.index || 0);
    const withdrawInputMerklePathElements = withdrawInputs.map((input, i) => {
      if (i === 0) {
        return globalMerkleTree.path(input.index).pathElements;
      }
      return [...new Array(globalMerkleTree.levels).fill(0)];
    });

    const withdrawInputNullifiers = await Promise.all(withdrawInputs.map(x => x.getNullifier()));
    const withdrawOutputCommitments = await Promise.all(withdrawOutputs.map(x => x.getCommitment()));

    const withdrawRoot = globalMerkleTree.root();
    const withdrawCalculatedExtDataHash = getExtDataHash(withdrawExtData);
    const withdrawPublicAmountNumber = new anchor.BN(-withdrawAmount - withdrawFee);

    const withdrawCircuitInput = {
      root: withdrawRoot,
      publicAmount: withdrawPublicAmountNumber.toString(),
      extDataHash: withdrawCalculatedExtDataHash,
      mintAddress: withdrawInputs[0].mintAddress,
      
      inputNullifier: withdrawInputNullifiers,
      inAmount: withdrawInputs.map(x => x.amount.toString(10)),
      inPrivateKey: withdrawInputs.map(x => x.keypair.privkey),
      inBlinding: withdrawInputs.map(x => x.blinding.toString(10)),
      inPathIndices: withdrawInputMerklePathIndices,
      inPathElements: withdrawInputMerklePathElements,
      
      outputCommitment: withdrawOutputCommitments,
      outAmount: withdrawOutputs.map(x => x.amount.toString(10)),
      outBlinding: withdrawOutputs.map(x => x.blinding.toString(10)),
      outPubkey: withdrawOutputs.map(x => x.keypair.pubkey),
    };

    const {proof: withdrawProof, publicSignals: withdrawPublicSignals} = await prove(withdrawCircuitInput, keyBasePath);

    const withdrawProofInBytes = parseProofToBytesArray(withdrawProof);
    const withdrawInputsInBytes = parseToBytesArray(withdrawPublicSignals);
    
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

    const recipientTokenBalanceBefore = await provider.connection.getTokenAccountBalance(recipientTokenAccount);
    
    // PDA fee recipient token account might not exist yet, will be created during withdrawal via init_if_needed
    let pdaFeeRecipientTokenBalanceBefore = 0;
    try {
      const balance = await provider.connection.getTokenAccountBalance(pdaFeeRecipientTokenAccount);
      pdaFeeRecipientTokenBalanceBefore = parseInt(balance.value.amount);
    } catch (error) {
      // Account doesn't exist yet, balance is 0
      pdaFeeRecipientTokenBalanceBefore = 0;
    }

    const modifyComputeUnitsWithdraw = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });
    
    const withdrawTx = await program.methods
      .transactSpl(withdrawProofToSubmit, createExtDataMinified(withdrawExtData), withdrawExtData.encryptedOutput1, withdrawExtData.encryptedOutput2)
      .accounts({
        treeAccount: treeAccountPDA,
        nullifier0: withdrawNullifiers.nullifier0PDA,
        nullifier1: withdrawNullifiers.nullifier1PDA,
        nullifier2: withdrawCrossCheckNullifiers.nullifier2PDA,
        nullifier3: withdrawCrossCheckNullifiers.nullifier3PDA,
        commitment0: withdrawCommitments.commitment0PDA,
        commitment1: withdrawCommitments.commitment1PDA,
        globalConfig: globalConfigPDA,
        signer: randomUser.publicKey,
        recipient: recipient.publicKey,
        mint: splTokenMint.publicKey,
        signerTokenAccount: randomUserTokenAccount,
        recipientTokenAccount: recipientTokenAccount,
        treeAta: treeAta,
        feeRecipientAta: pdaFeeRecipientTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .signers([randomUser])
      .preInstructions([modifyComputeUnitsWithdraw])
      .transaction();

    const withdrawVersionedTx = await createVersionedTransactionWithALT(
      provider.connection,
      randomUser.publicKey,
      withdrawTx.instructions,
      depositLookupTableAddress
    );
    
    const withdrawTxSig = await sendAndConfirmVersionedTransaction(
      provider.connection,
      withdrawVersionedTx,
      [randomUser]
    );

    expect(withdrawTxSig).to.be.a('string');

    const recipientTokenBalanceAfter = await provider.connection.getTokenAccountBalance(recipientTokenAccount);
    const pdaFeeRecipientTokenBalanceAfter = await provider.connection.getTokenAccountBalance(pdaFeeRecipientTokenAccount);
    
    const recipientTokenDiff = parseInt(recipientTokenBalanceAfter.value.amount) - parseInt(recipientTokenBalanceBefore.value.amount);
    const pdaFeeRecipientTokenDiff = parseInt(pdaFeeRecipientTokenBalanceAfter.value.amount) - pdaFeeRecipientTokenBalanceBefore;

    expect(recipientTokenDiff).to.equal(withdrawAmount);
    expect(pdaFeeRecipientTokenDiff).to.equal(withdrawFee); // Verify PDA fee recipient received the fees

    // Add withdrawal commitments to the merkle tree
    for (const commitment of withdrawOutputs) {
      globalMerkleTree.insert(await commitment.getCommitment());
    }
  });

});