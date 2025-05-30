import { Connection, Keypair, PublicKey } from '@solana/web3.js';
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
const WITHDRAW_AMOUNT = 50_000_000; // 0.05 SOL in lamports
const FEE_AMOUNT = 10_000; // 0.00001 SOL in lamports
const TRANSACT_IX_DISCRIMINATOR = Buffer.from([217, 149, 130, 143, 221, 52, 252, 119]);
const CIRCUIT_PATH = path.resolve(__dirname, '../artifacts/circuits/transaction2');
// Recipient address for withdrawal
const RECIPIENT_ADDRESS = new PublicKey('1NpWc4q6VYJmg9V3TQenvHMTr8qiDDrrT4TV27SxQms');

// Indexer API endpoint
const INDEXER_API_URL = 'https://api.thelive.bet';

// Load user keypair from script_keypair.json
const userKeypairJson = JSON.parse(readFileSync(path.join(__dirname, 'script_keypair.json'), 'utf-8'));
const user = Keypair.fromSecretKey(Uint8Array.from(userKeypairJson));

// Program ID for the zkcash program
const PROGRAM_ID = new PublicKey('BByY3XVe36QEn3omkkzZM7rst2mKqt4S4XMCrbM9oUTh');

// Configure connection to Solana devnet
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

// Function to query remote tree state from indexer API
async function queryRemoteTreeState(): Promise<{ root: string, nextIndex: number }> {
  try {
    console.log('Fetching Merkle root and nextIndex from API...');
    const response = await fetch(`${INDEXER_API_URL}/merkle/root`);
    if (!response.ok) {
      throw new Error(`Failed to fetch Merkle root and nextIndex: ${response.status} ${response.statusText}`);
    }
    const data = await response.json() as { root: string, nextIndex: number };
    console.log(`Fetched root from API: ${data.root}`);
    console.log(`Fetched nextIndex from API: ${data.nextIndex}`);
    return data;
  } catch (error) {
    console.error('Failed to fetch root and nextIndex from API:', error);
    throw error;
  }
}

// Function to fetch Merkle proof from API for a given commitment
async function fetchMerkleProof(commitment: string): Promise<{ pathElements: string[], pathIndices: number[] }> {
  try {
    console.log(`Fetching Merkle proof for commitment: ${commitment}`);
    const response = await fetch(`${INDEXER_API_URL}/merkle/proof/${commitment}`);
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

// Function to serialize proof and extData (same as original withdraw script)
function serializeProofAndExtData(proof: any, extData: any) {
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
}

// Function to submit withdraw request to indexer backend
async function submitWithdrawToIndexer(params: any): Promise<string> {
  try {
    console.log('Submitting withdraw request to indexer backend...');
    
    const response = await fetch(`${INDEXER_API_URL}/withdraw`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params)
    });

    if (!response.ok) {
      const errorData = await response.json() as { error?: string };
      throw new Error(`Withdraw request failed: ${response.status} ${response.statusText} - ${errorData.error || 'Unknown error'}`);
    }

    const result = await response.json() as { signature: string, success: boolean };
    console.log('Withdraw request submitted successfully!');
    console.log('Response:', result);
    
    return result.signature;
  } catch (error) {
    console.error('Failed to submit withdraw request to indexer:', error);
    throw error;
  }
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

    // Get all relevant balances before transaction
    const treeTokenAccountBalanceBefore = await connection.getBalance(treeTokenAccount);
    const recipientBalanceBefore = await connection.getBalance(RECIPIENT_ADDRESS);

    console.log('\nBalances before transaction:', JSON.stringify({
      treeTokenAccount: `${treeTokenAccountBalanceBefore / 1e9} SOL`,
      recipient: `${recipientBalanceBefore / 1e9} SOL`,
    }, null, 2));

    const MERKLE_TREE_DEPTH = 20;

    // Get current tree state
    const { root, nextIndex: currentNextIndex } = await queryRemoteTreeState();
    console.log(`Using tree root: ${root}`);
    console.log(`New UTXOs will be inserted at indices: ${currentNextIndex} and ${currentNextIndex + 1}`);

    // Generate a deterministic private key derived from the wallet keypair
    const utxoPrivateKey = encryptionService.deriveUtxoPrivateKey();
    
    // Create a UTXO keypair that will be used for all inputs and outputs
    const utxoKeypair = new UtxoKeypair(utxoPrivateKey, lightWasm);
    console.log('Using wallet-derived UTXO keypair for withdrawal');

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
    const unspentUtxos = nonZeroUtxos.filter((utxo, index) => !utxoSpentStatuses[index]);
    console.log(`Found ${unspentUtxos.length} unspent UTXOs available for spending`);

    // Calculate and log total unspent UTXO balance
    const totalUnspentBalance = unspentUtxos.reduce((sum, utxo) => sum.add(utxo.amount), new BN(0));
    console.log(`Total unspent UTXO balance before: ${totalUnspentBalance.toString()} lamports (${totalUnspentBalance.toNumber() / 1e9} SOL)`);

    if (unspentUtxos.length < 1) {
      console.error('Need at least 1 unspent UTXO to perform a withdrawal');
      return;
    }

    // Sort UTXOs by amount in descending order to use the largest ones first
    unspentUtxos.sort((a, b) => b.amount.cmp(a.amount));

    // Use the largest UTXO as first input, and either second largest UTXO or dummy UTXO as second input
    const firstInput = unspentUtxos[0];
    const secondInput = unspentUtxos.length > 1 ? unspentUtxos[1] : new Utxo({ 
      lightWasm,
      keypair: utxoKeypair,
      amount: '0'
    });
    
    const inputs = [firstInput, secondInput];
    const totalInputAmount = firstInput.amount.add(secondInput.amount);
    console.log(`Using UTXO with amount: ${firstInput.amount.toString()} and ${secondInput.amount.gt(new BN(0)) ? 'second UTXO with amount: ' + secondInput.amount.toString() : 'dummy UTXO'}`);

    if (totalInputAmount.lt(new BN(WITHDRAW_AMOUNT + FEE_AMOUNT))) {
      console.error(`Insufficient UTXO balance: ${totalInputAmount.toString()}. Need at least ${WITHDRAW_AMOUNT + FEE_AMOUNT}`);
      return;
    }

    // Calculate the change amount (what's left after withdrawal and fee)
    const changeAmount = totalInputAmount.sub(new BN(WITHDRAW_AMOUNT)).sub(new BN(FEE_AMOUNT));
    console.log(`Withdrawing ${WITHDRAW_AMOUNT} lamports with ${FEE_AMOUNT} fee, ${changeAmount.toString()} as change`);

    // Get Merkle proofs for both input UTXOs
    const inputMerkleProofs = await Promise.all(
      inputs.map(async (utxo, index) => {
        // For dummy UTXO (amount is 0), use a zero-filled proof
        if (utxo.amount.eq(new BN(0))) {
          return {
            pathElements: [...new Array(MERKLE_TREE_DEPTH).fill("0")],
            pathIndices: Array(MERKLE_TREE_DEPTH).fill(0)
          };
        }
        // For real UTXOs, fetch the proof from API
        const commitment = await utxo.getCommitment();
        return fetchMerkleProof(commitment);
      })
    );

    // Extract path elements and indices
    const inputMerklePathElements = inputMerkleProofs.map(proof => proof.pathElements);
    const inputMerklePathIndices = inputs.map(utxo => utxo.index || 0);

    // Create outputs: first output is change, second is dummy (required by protocol)
    const outputs = [
      new Utxo({ 
        lightWasm, 
        amount: changeAmount.toString(),
        keypair: utxoKeypair,
        index: currentNextIndex
      }), // Change output
      new Utxo({ 
        lightWasm, 
        amount: '0',
        keypair: utxoKeypair,
        index: currentNextIndex + 1
      }) // Empty UTXO
    ];

    // For withdrawals, extAmount is negative (funds leaving the system)
    const extAmount = -WITHDRAW_AMOUNT;
    const publicAmountForCircuit = new BN(extAmount).sub(new BN(FEE_AMOUNT)).add(FIELD_SIZE).mod(FIELD_SIZE);
    console.log(`Public amount calculation: (${extAmount} - ${FEE_AMOUNT} + FIELD_SIZE) % FIELD_SIZE = ${publicAmountForCircuit.toString()}`);

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

    console.log(`\nOutput[0] (change):`);
    await outputs[0].log();
    console.log(`\nOutput[1] (empty):`);
    await outputs[1].log();
    
    console.log(`\nEncrypted output 1 size: ${encryptedOutput1.length} bytes`);
    console.log(`Encrypted output 2 size: ${encryptedOutput2.length} bytes`);
    console.log(`Total encrypted outputs size: ${encryptedOutput1.length + encryptedOutput2.length} bytes`);

    // Test decryption to verify commitment values match
    console.log('\n=== TESTING DECRYPTION ===');
    console.log('Decrypting output 1 to verify commitment matches...');
    const decryptedUtxo1 = await encryptionService.decryptUtxo(encryptedOutput1, utxoKeypair, lightWasm);
    const decryptedCommitment1 = await decryptedUtxo1.getCommitment();
    console.log('Original commitment:', outputCommitments[0]);
    console.log('Decrypted commitment:', decryptedCommitment1);
    console.log('Commitment matches:', outputCommitments[0] === decryptedCommitment1);

    // Create the withdrawal ExtData with real encrypted outputs
    const extData = {
      // it can be any address
      recipient: RECIPIENT_ADDRESS,
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
        inputNullifier: inputNullifiers,
        outputCommitment: outputCommitments,
        publicAmount: publicAmountForCircuit.toString(),
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

    // Serialize the proof and extData
    const serializedProof = serializeProofAndExtData(proofToSubmit, extData);
    console.log(`Total serialized proof and extData size: ${serializedProof.length} bytes`);

    // Prepare withdraw parameters for indexer backend
    const withdrawParams = {
      serializedProof: serializedProof.toString('base64'),
      treeAccount: treeAccount.toString(),
      nullifier0PDA: nullifier0PDA.toString(),
      nullifier1PDA: nullifier1PDA.toString(),
      commitment0PDA: commitment0PDA.toString(),
      commitment1PDA: commitment1PDA.toString(),
      treeTokenAccount: treeTokenAccount.toString(),
      recipient: RECIPIENT_ADDRESS.toString(),
      feeRecipientAccount: feeRecipientAccount.toString(),
      deployer: deployer.toString(),
      extAmount: extAmount,
      encryptedOutput1: encryptedOutput1.toString('base64'),
      encryptedOutput2: encryptedOutput2.toString('base64'),
      fee: FEE_AMOUNT
    };

    console.log('Prepared withdraw parameters for indexer backend');

    // Submit to indexer backend instead of directly to Solana
    const signature = await submitWithdrawToIndexer(withdrawParams);
    console.log('Transaction signature:', signature);
    console.log(`Transaction link: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
    
    // Wait a moment for the transaction to be confirmed
    console.log('Waiting for transaction confirmation...');
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    // Check balances after transaction
    try {
      // Get all relevant balances after transaction
      const treeTokenAccountBalanceAfter = await connection.getBalance(treeTokenAccount);
      const recipientBalanceAfter = await connection.getBalance(RECIPIENT_ADDRESS);

      console.log('\nBalances after transaction:', JSON.stringify({
        treeTokenAccount: `${treeTokenAccountBalanceAfter / 1e9} SOL`,
        recipient: `${recipientBalanceAfter / 1e9} SOL`,
      }, null, 2));

      console.log('\nBalance changes:', JSON.stringify({
        treeTokenAccount: `${(treeTokenAccountBalanceAfter - treeTokenAccountBalanceBefore) / 1e9} SOL`,
        recipient: `${(recipientBalanceAfter - recipientBalanceBefore) / 1e9} SOL`,
      }, null, 2));

      // Fetch updated UTXOs and calculate new balance
      const updatedAllUtxos = await getMyUtxos(user, connection);
      const updatedNonZeroUtxos = updatedAllUtxos.filter(utxo => utxo.amount.gt(new BN(0)));
      const updatedUtxoSpentStatuses = await Promise.all(
        updatedNonZeroUtxos.map(utxo => isUtxoSpent(connection, utxo))
      );
      const updatedUnspentUtxos = updatedNonZeroUtxos.filter((utxo, index) => !updatedUtxoSpentStatuses[index]);
      const updatedTotalUnspentBalance = updatedUnspentUtxos.reduce((sum, utxo) => sum.add(utxo.amount), new BN(0));
      
      console.log(`Total unspent UTXO balance after: ${updatedTotalUnspentBalance.toString()} lamports (${updatedTotalUnspentBalance.toNumber() / 1e9} SOL)`);
      const balanceChange = updatedTotalUnspentBalance.sub(totalUnspentBalance);
      console.log(`UTXO balance change: ${balanceChange.toString()} lamports (${balanceChange.toNumber() / 1e9} SOL)`);
      
      // Check if UTXOs were added to the tree by fetching the tree account again
      console.log('\nFetching updated tree state...');
      const updatedTreeState = await queryRemoteTreeState();
      
      console.log('Tree state after withdrawal:');
      console.log('- Current tree nextIndex:', updatedTreeState.nextIndex);
      console.log('- Total UTXOs in tree:', updatedTreeState.nextIndex);
      console.log('- New tree root:', updatedTreeState.root);
      
      // Calculate the number of new UTXOs added (should be 2)
      const expectedNextIndex = currentNextIndex + 2;
      const utxosAdded = updatedTreeState.nextIndex - currentNextIndex;
      console.log(`UTXOs added in this withdrawal: ${utxosAdded} (expected: 2)`);
      
      if (updatedTreeState.nextIndex === expectedNextIndex) {
        console.log('Withdrawal successful! UTXOs were added to the Merkle tree.');
      } else {
        console.log(`Warning: Expected nextIndex to be ${expectedNextIndex}, but got ${updatedTreeState.nextIndex}`);
      }
    } catch (error) {
      console.error('Failed to fetch tree state after withdrawal:', error);
    }
  } catch (error: any) {
    console.error('Error during withdrawal:', error);
  }
}

// Run the withdrawal function
main(); 