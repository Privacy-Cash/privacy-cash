import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, sendAndConfirmTransaction, ComputeBudgetProgram } from '@solana/web3.js';
import { BN } from 'bn.js';
import { readFileSync } from 'fs';
import * as fs from 'fs';
import { Utxo } from './models/utxo';
import { getExtDataHash } from './utils/utils';
import { prove, parseProofToBytesArray, parseToBytesArray } from './utils/prover';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { WasmFactory } from '@lightprotocol/hasher.rs';
import { MerkleTree } from './utils/merkle_tree';
// We'll use anchor only for getting the provider
import * as anchor from "@coral-xyz/anchor";
import { EncryptionService } from './encryption';

dotenv.config();

// Constants
const DEPOSIT_AMOUNT = 1_000_000_000; // 1 SOL in lamports
const FEE_AMOUNT = 10_000; // 0.00001 SOL in lamports
const TRANSACT_IX_DISCRIMINATOR = Buffer.from([217, 149, 130, 143, 221, 52, 252, 119]);
const CIRCUIT_PATH = path.resolve(__dirname, '../artifacts/circuits/transaction2');

// Program ID for the zkcash program
const PROGRAM_ID = new PublicKey('BByY3XVe36QEn3omkkzZM7rst2mKqt4S4XMCrbM9oUTh');

// Configure connection to Solana devnet
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

interface MerkleTreeAccount {
  authority: PublicKey;
  nextIndex: typeof BN;
  subtrees: Uint8Array[];
  root: Uint8Array;
  rootHistory: Uint8Array[];
  rootIndex: typeof BN;
  bump: number;
  _padding: Uint8Array;
}

// Find nullifier PDAs for the given proof
function findNullifierPDAs(proof: any) {
  const [nullifier0PDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier0"), Buffer.from(proof.inputNullifiers[0])],
    PROGRAM_ID
  );
  
  const [nullifier1PDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier1"), Buffer.from(proof.inputNullifiers[1])],
    PROGRAM_ID
  );
  
  return { nullifier0PDA, nullifier1PDA };
}

// Find commitment PDAs for the given proof
function findCommitmentPDAs(proof: any) {
  const [commitment0PDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("commitment0"), Buffer.from(proof.outputCommitments[0])],
    PROGRAM_ID
  );
  
  const [commitment1PDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("commitment1"), Buffer.from(proof.outputCommitments[1])],
    PROGRAM_ID
  );
  
  return { commitment0PDA, commitment1PDA };
}

async function main() {
  try {
    // Initialize the light protocol hasher
    const lightWasm = await WasmFactory.getInstance();
    
    // Initialize the encryption service
    const encryptionService = new EncryptionService();
    
    // Load wallet keypair from deploy-keypair.json in anchor directory
    let payer: Keypair;
    
    try {
      // Try to load from deploy-keypair.json in anchor directory
      const anchorDirPath = path.join(__dirname, '..', 'anchor');
      const deployKeypairPath = path.join(anchorDirPath, 'deploy-keypair.json');
      const keypairJson = JSON.parse(readFileSync(deployKeypairPath, 'utf-8'));
      payer = Keypair.fromSecretKey(Uint8Array.from(keypairJson));
      console.log('Using deploy keypair from anchor directory');
      
      // Generate encryption key from the payer keypair
      encryptionService.generateEncryptionKey(payer);
      console.log('Encryption key generated from wallet keypair');
    } catch (err) {
      console.error('Could not load deploy-keypair.json from anchor directory');
      return;
    }

    console.log(`Using wallet: ${payer.publicKey.toString()}`);
    
    // Check wallet balance
    const balance = await connection.getBalance(payer.publicKey);
    console.log(`Wallet balance: ${balance / 1e9} SOL`);

    if (balance < DEPOSIT_AMOUNT + FEE_AMOUNT) {
      console.error(`Insufficient balance: ${balance / 1e9} SOL. Need at least ${(DEPOSIT_AMOUNT + FEE_AMOUNT) / 1e9} SOL.`);
      return;
    }
    
    // Derive PDA (Program Derived Addresses) for the tree account and other required accounts
    const [treeAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from('merkle_tree'), payer.publicKey.toBuffer()],
      PROGRAM_ID
    );

    const [feeRecipientAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from('fee_recipient'), payer.publicKey.toBuffer()],
      PROGRAM_ID
    );

    const [treeTokenAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from('tree_token'), payer.publicKey.toBuffer()],
      PROGRAM_ID
    );

    console.log('Using PDAs:');
    console.log(`Tree Account: ${treeAccount.toString()}`);
    console.log(`Fee Recipient Account: ${feeRecipientAccount.toString()}`);
    console.log(`Tree Token Account: ${treeTokenAccount.toString()}`);

    // Create the merkle tree with the pre-initialized poseidon hash
    const tree = new MerkleTree(20, lightWasm);

    // Get the empty tree root as a fallback
    let root = tree.root().toString();
    console.log(`tree root: ${root}`);

    // Check if the program is initialized by fetching the tree account directly
    try {
      const treeAccountInfo = await connection.getAccountInfo(treeAccount);
      if (!treeAccountInfo) {
        throw new Error('Tree account not found');
      }
      
      // Parse the account data manually
      const treeAccountData = {
        authority: new PublicKey(treeAccountInfo.data.slice(8, 40)),
        nextIndex: new BN(treeAccountInfo.data.slice(40, 48), 'le'),
        subtrees: Array.from({ length: 20 }, (_, i) => 
          treeAccountInfo.data.slice(48 + i * 32, 48 + (i + 1) * 32)
        ),
        root: treeAccountInfo.data.slice(48 + 20 * 32, 48 + 20 * 32 + 32),
        rootHistory: Array.from({ length: 10 }, (_, i) => 
          treeAccountInfo.data.slice(48 + 20 * 32 + 32 + i * 32, 48 + 20 * 32 + 32 + (i + 1) * 32)
        ),
        rootIndex: new BN(treeAccountInfo.data.slice(48 + 20 * 32 + 32 + 10 * 32, 48 + 20 * 32 + 32 + 10 * 32 + 8), 'le'),
        bump: treeAccountInfo.data[48 + 20 * 32 + 32 + 10 * 32 + 8],
        _padding: treeAccountInfo.data.slice(48 + 20 * 32 + 32 + 10 * 32 + 9)
      };
      
      console.log('Tree account found, program is initialized');
      
      // Extract the root from the tree account data
      const root = Buffer.from(treeAccountData.root).toString('hex');
      console.log('Current tree root:', root);
    } catch (error) {
      console.error('Tree account not found. Has the program been initialized?');
      return;
    }

    // Create inputs for the deposit (empty UTXOs)
    const inputs = [
      new Utxo({ lightWasm }),
      new Utxo({ lightWasm })
    ];

    // Calculate the output amount (deposit amount minus fee)
    const publicAmountNumber = new BN(DEPOSIT_AMOUNT - FEE_AMOUNT);
    const outputAmount = publicAmountNumber.toString();
    
    // Create outputs for the deposit
    const outputs = [
      new Utxo({ lightWasm, amount: outputAmount }), // Combined amount minus fee
      new Utxo({ lightWasm, amount: '0' }) // Empty UTXO
    ];
    
    // Create mock Merkle path data for the inputs
    const inputMerklePathIndices = inputs.map((input) => input.index || 0);
    
    // Create the Merkle paths for each input
    const inputMerklePathElements = inputs.map(() => {
      // Create an array of "0" strings for each level of the Merkle tree
      return [...new Array(tree.levels).fill("0")];
    });
    
    // Generate nullifiers and commitments
    const inputNullifiers = await Promise.all(inputs.map(x => x.getNullifier()));
    const outputCommitments = await Promise.all(outputs.map(x => x.getCommitment()));

    // Encrypt the UTXO data using a compact format
    const encryptedOutput1 = encryptionService.encrypt(
      `${outputs[0].amount.toString()}|${outputs[0].blinding.toString()}|${outputs[0].index}`
    );
    
    const encryptedOutput2 = encryptionService.encrypt(
      `${outputs[1].amount.toString()}|${outputs[1].blinding.toString()}|${outputs[1].index}`
    );

    console.log(`outputs[0]`, outputs[0])
    console.log(`outputs[1]`, outputs[1])
    
    console.log(`Encrypted output 1 size: ${encryptedOutput1.length} bytes`);
    console.log(`Encrypted output 2 size: ${encryptedOutput2.length} bytes`);

    // Create the deposit ExtData with real encrypted outputs
    const extData = {
      recipient: payer.publicKey,
      extAmount: new BN(DEPOSIT_AMOUNT),
      encryptedOutput1: encryptedOutput1,
      encryptedOutput2: encryptedOutput2,
      fee: new BN(FEE_AMOUNT)
    };

    // Calculate the extDataHash with the encrypted outputs
    const calculatedExtDataHash = getExtDataHash(extData);

    // Create the input for the proof generation
    const input = {
        // Common transaction data
        root: root,
        inputNullifier: inputNullifiers, // Use resolved values instead of Promise objects
        outputCommitment: outputCommitments, // Use resolved values instead of Promise objects
        publicAmount: outputAmount,
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

    console.log('Generating proof... (this may take a minute)');
    
    // Generate the zero-knowledge proof
    const {proof, publicSignals} = await prove(input, CIRCUIT_PATH);
    
    // Parse the proof and public signals into byte arrays
    const proofInBytes = parseProofToBytesArray(proof);
    const inputsInBytes = parseToBytesArray(publicSignals);
    
    // Create the proof object to submit to the program
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

    // Find PDAs for nullifiers and commitments
    const { nullifier0PDA, nullifier1PDA } = findNullifierPDAs(proofToSubmit);
    const { commitment0PDA, commitment1PDA } = findCommitmentPDAs(proofToSubmit);

    console.log('Submitting deposit transaction...');
    
    // Set compute budget for the transaction (needed for complex transactions)
    const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({ 
      units: 1_000_000 
    });

    // Create instruction for serializing and encoding the proof and extData
    const serializeProofAndExtData = (proof: any, extData: any) => {
      const proofBuf = Buffer.alloc(1000); // Allocate enough space
      let offset = 0;
      
      // Write proofA (64 bytes)
      proof.proofA.forEach((b: number) => {
        proofBuf.writeUInt8(b, offset);
        offset += 1;
      });
      
      // Write proofB (128 bytes)
      proof.proofB.forEach((b: number) => {
        proofBuf.writeUInt8(b, offset);
        offset += 1;
      });
      
      // Write proofC (64 bytes)
      proof.proofC.forEach((b: number) => {
        proofBuf.writeUInt8(b, offset);
        offset += 1;
      });
      
      // Write root (32 bytes)
      proof.root.forEach((b: number) => {
        proofBuf.writeUInt8(b, offset);
        offset += 1;
      });
      
      // Write publicAmount (32 bytes)
      proof.publicAmount.forEach((b: number) => {
        proofBuf.writeUInt8(b, offset);
        offset += 1;
      });
      
      // Write extDataHash (32 bytes)
      proof.extDataHash.forEach((b: number) => {
        proofBuf.writeUInt8(b, offset);
        offset += 1;
      });
      
      // Write input nullifiers (2 x 32 bytes)
      proof.inputNullifiers.forEach((nullifier: number[]) => {
        nullifier.forEach((b: number) => {
          proofBuf.writeUInt8(b, offset);
          offset += 1;
        });
      });
      
      // Write output commitments (2 x 32 bytes)
      proof.outputCommitments.forEach((commitment: number[]) => {
        commitment.forEach((b: number) => {
          proofBuf.writeUInt8(b, offset);
          offset += 1;
        });
      });

      // ExtData serialization
      const extDataBuf = Buffer.alloc(500); // Allocate enough space
      let extOffset = 0;
      
      // Recipient pubkey (32 bytes)
      extData.recipient.toBuffer().copy(extDataBuf, extOffset);
      extOffset += 32;
      
      // extAmount (8 bytes) - i64
      extDataBuf.writeBigInt64LE(BigInt(extData.extAmount.toString()), extOffset);
      extOffset += 8;
      
      // encrypted_output1 length and data
      const encOut1Len = extData.encryptedOutput1.length;
      extDataBuf.writeUInt32LE(encOut1Len, extOffset);
      extOffset += 4;
      extData.encryptedOutput1.copy(extDataBuf, extOffset);
      extOffset += encOut1Len;
      
      // encrypted_output2 length and data
      const encOut2Len = extData.encryptedOutput2.length;
      extDataBuf.writeUInt32LE(encOut2Len, extOffset);
      extOffset += 4;
      extData.encryptedOutput2.copy(extDataBuf, extOffset);
      extOffset += encOut2Len;
      
      // fee (8 bytes) - u64
      extDataBuf.writeBigUInt64LE(BigInt(extData.fee.toString()), extOffset);
      extOffset += 8;
      
      // Combine instruction discriminator with proof and extData
      const instructionData = Buffer.concat([
        TRANSACT_IX_DISCRIMINATOR,
        proofBuf.slice(0, offset),
        extDataBuf.slice(0, extOffset)
      ]);
      
      return instructionData;
    };

    // Serialize the proof and extData
    const serializedProof = serializeProofAndExtData(proofToSubmit, extData);
    console.log(`Total serialized proof and extData size: ${serializedProof.length} bytes`);

    // Create the transaction instruction
    const instruction = new TransactionInstruction({
      keys: [
        { pubkey: treeAccount, isSigner: false, isWritable: true },
        { pubkey: nullifier0PDA, isSigner: false, isWritable: true },
        { pubkey: nullifier1PDA, isSigner: false, isWritable: true },
        { pubkey: commitment0PDA, isSigner: false, isWritable: true },
        { pubkey: commitment1PDA, isSigner: false, isWritable: true },
        { pubkey: treeTokenAccount, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: false, isWritable: true },
        { pubkey: feeRecipientAccount, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: false, isWritable: false },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data: serializedProof,
    });

    // Create transaction with compute budget instruction and the main instruction
    const transaction = new Transaction()
      .add(modifyComputeUnits)
      .add(instruction);
    
    // Sign and send the transaction
    const signature = await sendAndConfirmTransaction(connection, transaction, [payer]);
    console.log('Transaction sent:', signature);
    console.log(`Transaction link: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
  } catch (error: any) {
    console.error('Error during deposit:', error);
  }
}

// Run the deposit function
main(); 