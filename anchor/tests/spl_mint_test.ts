import * as anchor from "@coral-xyz/anchor";
import { Program, EventParser, BorshCoder } from "@coral-xyz/anchor";
import { Zkcash } from "../target/types/zkcash";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress, createInitializeMintInstruction, createAssociatedTokenAccountInstruction, createMintToInstruction, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";
import { getExtDataHash, getMintAddressField } from "./lib/utils";
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
it("Fails deposit instruction for non USDC token mint", async () => {

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
    // Store full mint address (base58 string), will be converted to field representation in getCommitment()
    const mintAddressBase58 = splTokenMint.publicKey.toBase58();
    const mintAddressField = getMintAddressField(splTokenMint.publicKey);
    
    const inputs = [
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 }),
      new Utxo({ lightWasm, mintAddress: mintAddressBase58 })
    ];

    const outputAmount = (depositAmount - calculatedDepositFee).toString();
    const outputs = [
      new Utxo({ lightWasm, amount: outputAmount, index: globalMerkleTree._layers[0].length, mintAddress: mintAddressBase58 }), // Combined amount minus fee
      new Utxo({ lightWasm, amount: '0', mintAddress: mintAddressBase58 }) // Empty UTXO
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
     mintAddress: mintAddressField, // Use field representation (31 bytes for SPL, 32 for SOL)
     
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
    try {
        const depositTxSig = await sendAndConfirmVersionedTransaction(
            provider.connection,
            depositVersionedTx,
            [randomUser]
          );
    } catch (error) {
        const errorString = error.toString();
        expect(errorString.includes("0x1782") || errorString.includes("Invalid mint address: mint address is not allowed")).to.be.true;
    }
    
  });

});