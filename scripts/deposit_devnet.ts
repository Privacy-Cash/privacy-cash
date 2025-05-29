import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, sendAndConfirmTransaction, ComputeBudgetProgram } from '@solana/web3.js';
import BN from 'bn.js';
import { readFileSync } from 'fs';
import { Utxo } from './models/utxo';
import { getExtDataHash } from './utils/utils';
import { prove, parseProofToBytesArray, parseToBytesArray } from './utils/prover';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { WasmFactory } from '@lightprotocol/hasher.rs';
import { MerkleTree } from './utils/merkle_tree';
import { EncryptionService } from './utils/encryption';
import { Keypair as UtxoKeypair } from './models/keypair';
import { getMyUtxos, isUtxoSpent } from './fetch_user_utxos';
import { FIELD_SIZE } from './utils/constants';

dotenv.config();

// Constants
const DEPOSIT_AMOUNT = 80_000_000; // 0.08 SOL in lamports
const FEE_AMOUNT = 10_000; // 0.00001 SOL in lamports
const TRANSACT_IX_DISCRIMINATOR = Buffer.from([217, 149, 130, 143, 221, 52, 252, 119]);
const CIRCUIT_PATH = path.resolve(__dirname, '../artifacts/circuits/transaction2');

// Load user keypair from script_keypair.json
const userKeypairJson = JSON.parse(readFileSync(path.join(__dirname, 'script_keypair.json'), 'utf-8'));
const user = Keypair.fromSecretKey(Uint8Array.from(userKeypairJson));

// Program ID for the zkcash program
const PROGRAM_ID = new PublicKey('BByY3XVe36QEn3omkkzZM7rst2mKqt4S4XMCrbM9oUTh');

// Configure connection to Solana devnet
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

// Function to fetch Merkle proof from API for a given commitment
async function fetchMerkleProof(commitment: string): Promise<{ pathElements: string[], pathIndices: number[] }> {
  try {
    console.log(`Fetching Merkle proof for commitment: ${commitment}`);
    const response = await fetch(`https://api.thelive.bet/merkle/proof/${commitment}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch Merkle proof: ${response.status} ${response.statusText}`);
    }
    const data = await response.json() as { pathElements: string[], pathIndices: number[] };
    console.log(`✓ Fetched Merkle proof with ${data.pathElements.length} elements`);
    return data;
  } catch (error) {
    console.error(`Failed to fetch Merkle proof for commitment ${commitment}:`, error);
    throw error;
  }
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

// Function to get tree state
async function getTreeState(treeAccount: PublicKey) {
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
  
  return treeAccountData;
}

async function main() {
  try {
    // Initialize the light protocol hasher
    const lightWasm = await WasmFactory.getInstance();
    
    // Initialize the encryption service
    const encryptionService = new EncryptionService();
    
    // Use hardcoded deployer public key
    const deployer = new PublicKey('1NpWc4q6VYJmg9V3TQenvHMTr8qiDDrrT4TV27SxQms');
    console.log('Using hardcoded deployer public key');
    
    // Generate encryption key from the user keypair
    encryptionService.deriveEncryptionKeyFromWallet(user);
    console.log('Encryption key generated from user keypair');

    console.log(`Deployer wallet: ${deployer.toString()}`);
    console.log(`User wallet: ${user.publicKey.toString()}`);
    
    // Check wallet balance
    const balance = await connection.getBalance(user.publicKey);
    console.log(`Wallet balance: ${balance / 1e9} SOL`);

    if (balance < DEPOSIT_AMOUNT + FEE_AMOUNT) {
      console.error(`Insufficient balance: ${balance / 1e9} SOL. Need at least ${(DEPOSIT_AMOUNT + FEE_AMOUNT) / 1e9} SOL.`);
      return;
    }
    
    // Derive PDA (Program Derived Addresses) for the tree account and other required accounts
    const [treeAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from('merkle_tree'), deployer.toBuffer()],
      PROGRAM_ID
    );

    const [feeRecipientAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from('fee_recipient'), deployer.toBuffer()],
      PROGRAM_ID
    );

    const [treeTokenAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from('tree_token'), deployer.toBuffer()],
      PROGRAM_ID
    );

    console.log('Using PDAs:');
    console.log(`Tree Account: ${treeAccount.toString()}`);
    console.log(`Fee Recipient Account: ${feeRecipientAccount.toString()}`);
    console.log(`Tree Token Account: ${treeTokenAccount.toString()}`);

    // Create the merkle tree with the pre-initialized poseidon hash
    const tree = new MerkleTree(20, lightWasm);

    // Initialize root variable
    let root: string;

    try {
      console.log('Fetching Merkle root from API...');
      const response = await fetch('https://api.thelive.bet/merkle/root');
      if (!response.ok) {
        throw new Error(`Failed to fetch Merkle root: ${response.status} ${response.statusText}`);
      }
      const data = await response.json() as { root: string };
      root = data.root;
      console.log(`Fetched root from API: ${root}`);
    } catch (error) {
      console.error('Failed to fetch root from API, exiting');
      return; // Return early without a fallback
    }

    console.log(`Using tree root: ${root}`);

    // Generate a deterministic private key derived from the wallet keypair
    const utxoPrivateKey = encryptionService.deriveUtxoPrivateKey();
    
    // Create a UTXO keypair that will be used for all inputs and outputs
    const utxoKeypair = new UtxoKeypair(utxoPrivateKey, lightWasm);
    console.log('Using wallet-derived UTXO keypair for deposit');

    // Fetch existing UTXOs for this user
    console.log('\nFetching existing UTXOs...');
    const allUtxos = await getMyUtxos(user, connection);
    console.log(`Found ${allUtxos.length} total UTXOs`);
    
    // Filter out zero-amount UTXOs (dummy UTXOs that can't be spent)
    const nonZeroUtxos = allUtxos.filter(utxo => utxo.amount.gt(new BN(0)));
    console.log(`Found ${nonZeroUtxos.length} non-zero UTXOs`);
    
    // Check which non-zero UTXOs are unspent
    console.log('Checking which UTXOs are unspent...');
    const utxoSpentStatuses = await Promise.all(
      nonZeroUtxos.map(utxo => isUtxoSpent(connection, utxo))
    );
    
    // Filter to only include unspent UTXOs
    const existingUnspentUtxos = nonZeroUtxos.filter((utxo, index) => !utxoSpentStatuses[index]);
    console.log(`Found ${existingUnspentUtxos.length} unspent UTXOs available for spending`);

    // Calculate output amounts and external amount based on scenario
    let extAmount: number;
    let outputAmount: string;
    
    // Create inputs based on whether we have existing UTXOs
    let inputs: Utxo[];
    let inputMerklePathIndices: number[];
    let inputMerklePathElements: string[][];

    if (existingUnspentUtxos.length === 0) {
      // Scenario 1: Fresh deposit with dummy inputs - add new funds to the system
      extAmount = DEPOSIT_AMOUNT;
      outputAmount = new BN(DEPOSIT_AMOUNT).sub(new BN(FEE_AMOUNT)).toString();
      
      console.log(`Fresh deposit scenario (no existing UTXOs):`);
      console.log(`External amount (deposit): ${extAmount}`);
      console.log(`Fee amount: ${FEE_AMOUNT}`);
      console.log(`Output amount: ${outputAmount}`);
      
      // Use two dummy UTXOs as inputs
      inputs = [
        new Utxo({ 
          lightWasm,
          keypair: utxoKeypair
        }),
        new Utxo({ 
          lightWasm,
          keypair: utxoKeypair
        })
      ];
      
      // Both inputs are dummy, so use mock indices and zero-filled Merkle paths
      inputMerklePathIndices = inputs.map((input) => input.index || 0);
      inputMerklePathElements = inputs.map(() => {
        return [...new Array(tree.levels).fill("0")];
      });
    } else {
      // Scenario 2: Deposit that consolidates with existing UTXO
      const firstUtxo = existingUnspentUtxos[0];
      const firstUtxoAmount = firstUtxo.amount;
      extAmount = DEPOSIT_AMOUNT; // Still depositing new funds
      
      // Output combines existing UTXO amount + new deposit amount - fee
      outputAmount = firstUtxoAmount.add(new BN(DEPOSIT_AMOUNT)).sub(new BN(FEE_AMOUNT)).toString();
      
      console.log(`Deposit with consolidation scenario:`);
      console.log(`Existing UTXO amount: ${firstUtxoAmount.toString()}`);
      console.log(`New deposit amount: ${DEPOSIT_AMOUNT}`);
      console.log(`Fee amount: ${FEE_AMOUNT}`);
      console.log(`Output amount (existing + deposit - fee): ${outputAmount}`);
      console.log(`External amount (deposit): ${extAmount}`);
      
      console.log('\nFirst UTXO to be consolidated:');
      await firstUtxo.log();

      // Use first existing UTXO as first input, dummy UTXO as second input
      inputs = [
        firstUtxo, // Use the first existing UTXO
        new Utxo({ 
          lightWasm,
          keypair: utxoKeypair
        }) // Dummy UTXO for second input
      ];

      // Fetch Merkle proof for the first (real) UTXO
      const firstUtxoCommitment = await firstUtxo.getCommitment();
      const firstUtxoMerkleProof = await fetchMerkleProof(firstUtxoCommitment);
      
      // Use the real pathIndices from API for first input, mock index for second input
      inputMerklePathIndices = [
        firstUtxo.index || 0, // Use the real UTXO's index  
        0 // Dummy UTXO index
      ];
      
      // Create Merkle path elements: real proof for first input, zeros for second input
      inputMerklePathElements = [
        firstUtxoMerkleProof.pathElements, // Real Merkle proof for existing UTXO
        [...new Array(tree.levels).fill("0")] // Zero-filled for dummy UTXO
      ];
      
      console.log(`Using real UTXO with amount: ${firstUtxo.amount.toString()} and index: ${firstUtxo.index}`);
      console.log(`Merkle proof path indices from API: [${firstUtxoMerkleProof.pathIndices.join(', ')}]`);
    }
    
    const publicAmountForCircuit = new BN(extAmount).sub(new BN(FEE_AMOUNT)).add(FIELD_SIZE).mod(FIELD_SIZE);
    console.log(`Public amount calculation: (${extAmount} - ${FEE_AMOUNT} + FIELD_SIZE) % FIELD_SIZE = ${publicAmountForCircuit.toString()}`);
    
    // Get current tree state to determine where new UTXOs will be inserted
    console.log('Fetching current tree state to determine UTXO indices...');
    const currentTreeState = await getTreeState(treeAccount);
    const currentNextIndex = currentTreeState.nextIndex.toNumber();
    console.log(`Current tree nextIndex: ${currentNextIndex}`);
    console.log(`New UTXOs will be inserted at indices: ${currentNextIndex} and ${currentNextIndex + 1}`);

    // Create outputs for the transaction with the same shared keypair
    const outputs = [
      new Utxo({ 
        lightWasm, 
        amount: outputAmount,
        keypair: utxoKeypair,
        index: currentNextIndex // This UTXO will be inserted at currentNextIndex
      }), // Output with value (either deposit amount minus fee, or input amount minus fee)
      new Utxo({ 
        lightWasm, 
        amount: '0',
        keypair: utxoKeypair,
        index: currentNextIndex + 1 // This UTXO will be inserted at currentNextIndex + 1
      }) // Empty UTXO
    ];
    
    // Verify this matches the circuit balance equation: sumIns + publicAmount = sumOuts
    const sumIns = inputs.reduce((sum, input) => sum.add(input.amount), new BN(0));
    const sumOuts = outputs.reduce((sum, output) => sum.add(output.amount), new BN(0));
    console.log(`Circuit balance check: sumIns(${sumIns.toString()}) + publicAmount(${publicAmountForCircuit.toString()}) should equal sumOuts(${sumOuts.toString()})`);
    
    // Convert to circuit-compatible format
    const publicAmountCircuitResult = sumIns.add(publicAmountForCircuit).mod(FIELD_SIZE);
    console.log(`Balance verification: ${sumIns.toString()} + ${publicAmountForCircuit.toString()} (mod FIELD_SIZE) = ${publicAmountCircuitResult.toString()}`);
    console.log(`Expected sum of outputs: ${sumOuts.toString()}`);
    console.log(`Balance equation satisfied: ${publicAmountCircuitResult.eq(sumOuts)}`);
    
    // Generate nullifiers and commitments
    const inputNullifiers = await Promise.all(inputs.map(x => x.getNullifier()));
    const outputCommitments = await Promise.all(outputs.map(x => x.getCommitment()));

    // Save original commitment and nullifier values for verification
    console.log('\n=== UTXO VALIDATION ===');
    console.log('Output 0 Commitment:', outputCommitments[0]);
    console.log('Output 1 Commitment:', outputCommitments[1]);
    
    // Encrypt the UTXO data using a compact format that includes the keypair
    console.log('\nEncrypting UTXOs with keypair data...');
    const encryptedOutput1 = encryptionService.encryptUtxo(outputs[0]);
    const encryptedOutput2 = encryptionService.encryptUtxo(outputs[1]);

    console.log(`\nOutput[0] (with value):`);
    await outputs[0].log();
    console.log(`\nOutput[1] (empty):`);
    await outputs[1].log();
    
    console.log(`\nEncrypted output 1 size: ${encryptedOutput1.length} bytes`);
    console.log(`Encrypted output 2 size: ${encryptedOutput2.length} bytes`);
    console.log(`Total encrypted outputs size: ${encryptedOutput1.length + encryptedOutput2.length} bytes (this is just the data size, not the count)`);
    
    // Test decryption to verify commitment values match
    console.log('\n=== TESTING DECRYPTION ===');
    console.log('Decrypting output 1 to verify commitment matches...');
    const decryptedUtxo1 = await encryptionService.decryptUtxo(encryptedOutput1, utxoKeypair, lightWasm);
    const decryptedCommitment1 = await decryptedUtxo1.getCommitment();
    console.log('Original commitment:', outputCommitments[0]);
    console.log('Decrypted commitment:', decryptedCommitment1);
    console.log('Commitment matches:', outputCommitments[0] === decryptedCommitment1);

    // Create the deposit ExtData with real encrypted outputs
    const extData = {
      recipient: user.publicKey,
      extAmount: new BN(extAmount),
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
        publicAmount: publicAmountForCircuit.toString(), // Use proper field arithmetic result
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
        // recipient
        { pubkey: user.publicKey, isSigner: false, isWritable: true },
        // fee recipient
        { pubkey: feeRecipientAccount, isSigner: false, isWritable: true },
        // fee recipient
        { pubkey: deployer, isSigner: false, isWritable: false },
        // signer
        { pubkey: user.publicKey, isSigner: true, isWritable: true },
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
    const signature = await sendAndConfirmTransaction(connection, transaction, [user]);
    console.log('Transaction sent:', signature);
    console.log(`Transaction link: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
    
    // Wait a moment for the transaction to be confirmed
    console.log('Waiting for transaction confirmation...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Check if UTXOs were added to the tree by fetching the tree account again
    try {
      console.log('Fetching updated tree state...');
      const updatedTreeState = await getTreeState(treeAccount);
      
      console.log('Tree state after deposit:');
      console.log('- Current tree nextIndex:', updatedTreeState.nextIndex.toString());
      console.log('- Total UTXOs in tree:', updatedTreeState.nextIndex.toString());
      console.log('- Root Index:', updatedTreeState.rootIndex.mod(new BN(10)).toString());
      
      // Extract the root from the tree account data
      const newRoot = Buffer.from(updatedTreeState.root).toString('hex');
      console.log('- New tree root:', newRoot);
      
      // Calculate the number of new UTXOs added
      const previousState = await getTreeState(treeAccount);
      const utxosAdded = updatedTreeState.nextIndex.sub(previousState.nextIndex).toString();
      console.log('UTXOs added in this deposit:', utxosAdded);
      console.log('Deposit successful! UTXOs were added to the Merkle tree.');
    } catch (error) {
      console.error('Failed to fetch tree account after deposit:', error);
    }
  } catch (error: any) {
    console.error('Error during deposit:', error);
  }
}

// Run the deposit function
main(); 