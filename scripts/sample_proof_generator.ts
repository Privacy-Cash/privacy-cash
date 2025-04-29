/**
 * Sample Proof Generator
 * 
 * Demonstrates how to use the prover module to generate zero-knowledge proofs
 * with appropriate sample inputs for testing purposes.
 * Based on: https://github.com/tornadocash/tornado-nova
 */

/// <reference path="./types.d.ts" />

import { prove, verify, Proof } from './prover';
import BN from 'bn.js';
import * as fs from 'fs';
import * as path from 'path';
import { utils } from 'ffjavascript';
import MerkleTree, { Element } from 'fixed-merkle-tree';
import { Utxo } from './models/utxo';
import { getExtDataHash, mockEncrypt, poseidonHash,poseidonHash2ToString, toFixedHex } from './utils/utils';
import { FIELD_SIZE } from './utils/constants';
import { Keypair } from './models/keypair';

/**
 * Generates a sample ZK proof using the main proving method
 * 
 * @param options Optional parameters for the proof generation
 * @returns A promise that resolves to an object containing the proof components and public inputs
 */
async function generateSampleProofForFirstDeposit(): Promise<{
  // proofA: Uint8Array;
  // proofB: Uint8Array;
  // proofC: Uint8Array;
  // publicSignals: Uint8Array[];
}> {
  // Use provided values or defaults
  const amount1 = '1000000000'; // 1 SOL in lamports
  const amount2 = '100000000';  // 0.5 SOL in lamports
  const blinding1 = new BN('1000000000'); // Use fixed value for consistency
  const blinding2 = new BN('500000000');  // Use fixed value for consistency
  const fee = '100000000'; // Default 0.1 SOL fee
  const recipient = '0x1111111111111111111111111111111111111111'; // Default recipient address
  const zeroValue = 11850551329423159860688778991827824730037759162201783566284850822760196767874
  
  // Create the merkle tree with the pre-initialized poseidon hash
  const tree = new MerkleTree(20, [], {
    hashFunction: poseidonHash2ToString,
    zeroElement: zeroValue
  });
  
  // Log the root in decimal
  console.log(`Merkle tree root (decimal): ${tree.root.toString()}`);
  console.log(`Merkle tree root (hex): 0x${BigInt(tree.root.toString()).toString(16)}`);
  
  console.log(`Using amounts: ${amount1}, ${amount2}`);
  console.log(`Using blinding factors: ${blinding1.toString(10).substring(0, 10)}..., ${blinding2.toString(10).substring(0, 10)}...`);

  // Create inputs for the first deposit
  const inputs = [
    new Utxo({ }),
    new Utxo({ })
  ];

  const pubkeys = await Promise.all(inputs.map(async (x) => await x.keypair.pubkey));
  console.log("!!!!!!pubkeys outside getPubkeyAsync", {pubkeys});

  // Create outputs (UTXOs that are being created)
  const outputAmount = '2900000000'; // Subtract fee
  const outputs = [
    new Utxo({ amount: outputAmount }), // Combined amount minus fee
    new Utxo({ amount: '0' }) // Empty UTXO
  ];

  // Calculate extAmount (amount being deposited or withdrawn)
  // outputs - inputs + fee (same formula as in Tornado Nova)
  const inputsSum = inputs.reduce((sum, x) => sum.add(x.amount), new BN(0))
  const outputsSum = outputs.reduce((sum, x) => sum.add(x.amount), new BN(0))
  const extAmount = new BN(fee)
    .add(outputsSum)
    .sub(inputsSum)
  const publicAmount = new BN(extAmount).sub(new BN(fee)).add(FIELD_SIZE).mod(FIELD_SIZE).toString()

  console.log(`outputsSum: ${outputsSum.toString(10)}, inputsSum: ${inputsSum.toString(10)},
    extAmount: ${extAmount.toString(10)}, publicAmount: ${publicAmount}`);

  // Create mock Merkle path data (normally built from the tree)
  const inputMerklePathIndices = inputs.map((input) => input.index || 0);
  
  // For first deposit into an empty tree, we need to create empty/zero paths
  // We'll create an array of zero elements for each level of the Merkle tree
  const zeroElements: string[] = [];
  
  // Access the zero element from the tree options configuration
  let currentZero = '0x29f9a0a07a22ab214d00aaa0190f54509e853f3119009baecb0035347606b0a9'; // Level 20 zero value
  
  // Generate the zero elements for each level
  for (let i = 0; i < 20; i++) {
    zeroElements.push(currentZero);
    // Calculate the next level's zero element by hashing the current zero with itself
    currentZero = poseidonHash2ToString(currentZero, currentZero);
  }
  
  // Create the Merkle paths for each input
  const inputMerklePathElements = inputs.map(() => {
    // Return an array of zero elements as the path for each input
    // Create a copy of the zeroElements array to avoid modifying the original
    return [...zeroElements];
  });

  // Use the properly calculated Merkle tree root
  const root = tree.root.toString();
  
  // Resolve all async operations before creating the input object
  // Await nullifiers and commitments to get actual values instead of Promise objects
  const inputNullifiers = await Promise.all(inputs.map(x => x.getNullifier()));
  const outputCommitments = await Promise.all(outputs.map(x => x.getCommitment()));
  
  // Create extData structure following Tornado Nova approach
  // See: https://github.com/tornadocash/tornado-nova/blob/f9264eeffe48bf5e04e19d8086ee6ec58cdf0d9e/src/index.js#L61
  const extData = {
    recipient: recipient,
    extAmount: extAmount.toString(10),
    encryptedOutput1: mockEncrypt(outputs[0]),
    encryptedOutput2: mockEncrypt(outputs[1]),
  };
  
  // Generate extDataHash from the extData structure
  // See: https://github.com/tornadocash/tornado-nova/blob/f9264eeffe48bf5e04e19d8086ee6ec58cdf0d9e/src/index.js#L74
  const extDataHash = await getExtDataHash(extData);
  console.log(`Using extDataHash: ${extDataHash}, with extData: ${JSON.stringify(extData)}`);
  
  // Following the exact input structure from Tornado Cash Nova
  // https://github.com/tornadocash/tornado-nova/blob/f9264eeffe48bf5e04e19d8086ee6ec58cdf0d9e/src/index.js#L76-L97
  const input = {
    // Common transaction data
    root: root,
    inputNullifier: inputNullifiers, // Use resolved values instead of Promise objects
    outputCommitment: outputCommitments, // Use resolved values instead of Promise objects
    publicAmount: publicAmount,
    extDataHash: extDataHash,
    
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

  // Log the input object structure for debugging
  console.log('Generating proof for inputs:', JSON.stringify(input, (key, value) => 
    BN.isBN(value) ? `<BN: ${value.toString(16)}>` : value, 2));

  // Path to the proving key files (wasm and zkey)
  // Try with both circuits to see which one works
  const keyBasePath = path.resolve(__dirname, '../artifacts/circuits/transaction2');
  
  console.log('Generating proof with inputs structured like Tornado Cash Nova...');
  console.log('Input structure:', Object.keys(input).join(', '));
  
  try {
    // Process the input with our custom preprocessor before passing to the prover
    console.log(`Using circuit files from: ${keyBasePath}`);
    console.log(`Checking files exist: ${fs.existsSync(keyBasePath + '.wasm')}, ${fs.existsSync(keyBasePath + '.zkey')}`);
    
    console.log('Sample input values:');
    console.log('- root:', input.root);
    console.log('- publicAmount:', input.publicAmount);
    console.log('- extDataHash:', input.extDataHash);
    console.log('- inAmount[0]:', input.inAmount[0]);
    console.log('- inPrivateKey[0]:', input.inPrivateKey[0]);
    console.log('- sumIns:', inputs.reduce((sum, x) => sum.add(x.amount), new BN(0)).toString(10));
    console.log('- sumOuts:', outputs.reduce((sum, x) => sum.add(x.amount), new BN(0)).toString(10));
    console.log('- inPathIndices:', input.inPathIndices);
    console.log('- outputCommitment:', input.outputCommitment);
    
    // Use the updated prove function that returns an object with proof components
    const {proof, publicSignals} = await prove(input, keyBasePath);
    
    console.log('Proof generated successfully!');
    console.log('Public signals:');
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
      
      console.log(`[${index}]: ${signal} (${matchedKey})`);
    });
    
    // Try verification with proper field element handling
    const processedPublicSignals = utils.unstringifyBigInts(publicSignals);
    const processedProof = utils.unstringifyBigInts(proof);

    try {
      // First attempt with processed signals
      const res = await verify(path.resolve(__dirname, "../artifacts/circuits/verifyingkey2.json"),
        processedPublicSignals, processedProof);
      console.log('!!!!!!Verification result (with processed signals):', res);
      
      return {proof, publicSignals};
    } catch (error: any) {
      console.error('Verification error:', error.message);
      console.error('This indicates a mismatch between the circuit, prover, and verification key.');
      console.log('You may need to:');
      console.log('1. Recompile the circuit after making changes to transaction2.circom');
      console.log('2. Regenerate the verification key');
      console.log('3. Make sure field element encodings are consistent');
      throw error;
    }
  } catch (error) {
    console.error('Error generating proof:', error);
    if (error instanceof Error) {
      console.error('Error details:', error.message);
      console.error('Stack trace:', error.stack);
    }
    throw error;
  }
}

async function generateSampleProofForWithdraw(): Promise<{
  // proofA: Uint8Array;
  // proofB: Uint8Array;
  // proofC: Uint8Array;
  // publicSignals: Uint8Array[];
}> {
  // Use provided values or defaults
  const amount1 = '1000000000'; // 1 SOL in lamports
  const amount2 = '100000000';  // 0.5 SOL in lamports
  const blinding1 = new BN('1000000000'); // Use fixed value for consistency
  const blinding2 = new BN('500000000');  // Use fixed value for consistency
  const fee = '100000000'; // Default 0.1 SOL fee
  const recipient = '0x1111111111111111111111111111111111111111'; // Default recipient address
  // from https://github.com/tornadocash/tornado-nova/blob/f9264eeffe48bf5e04e19d8086ee6ec58cdf0d9e/contracts/MerkleTreeWithHistory.sol#L125C32-L125C98
  const zeroValue = '0x2fe54c60d3acabf3343a35b6eba15db4821b340f76e741e2249685ed4899af6c'
  
  // Create the merkle tree with the pre-initialized poseidon hash
  const tree = new MerkleTree(20, [], {
    hashFunction: poseidonHash2ToString,
    zeroElement: zeroValue
  });

  // Log the root in decimal
  console.log(`Merkle tree root (decimal): ${tree.root.toString()}`);
  console.log(`Merkle tree root (hex): 0x${BigInt(tree.root.toString()).toString(16)}`);
  
  console.log(`Using amounts: ${amount1}, ${amount2}`);
  console.log(`Using blinding factors: ${blinding1.toString(10).substring(0, 10)}..., ${blinding2.toString(10).substring(0, 10)}...`);

  // Create inputs for the first deposit
  const inputs = [
    new Utxo({ 
      amount: new BN(2900000000),
      blinding: new BN(1000000000),
      index: 0,
      keypair: new Keypair("0x0cb0668299bbfc5a53ab4ca18468fd8d2d45b37f5752c5a2291fc66f4f91687a")
    }),
    // second input is empty
    new Utxo({
    })
  ];

  const inCommitments = [];
  for (const input of inputs) {
    const commitment = await input.getCommitment();
    const hexedCommitment = toFixedHex(commitment);
    tree.insert(hexedCommitment);
    inCommitments.push(hexedCommitment);
  }

  const inputMerklePathIndices = []
  const inputMerklePathElements: Element[][] = []
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i]
    if (input.amount > new BN(0)) {
      const commitment = inCommitments[i]
      input.index = tree.indexOf(commitment)
      if (input.index < 0) {
        throw new Error(`Input commitment ${commitment} was not found`)
      }
      inputMerklePathIndices.push(input.index)
      inputMerklePathElements.push(tree.path(input.index).pathElements)
    } else {
      inputMerklePathIndices.push(0)
      inputMerklePathElements.push(new Array(tree.levels).fill(0))
    }
  }

  const pubkeys = await Promise.all(inputs.map(async (x) => await x.keypair.pubkey));
  console.log("!!!!!!pubkeys outside getPubkeyAsync", {pubkeys});

  // Create outputs (UTXOs that are being created)
  const outputAmount = '1900000000';
  const outputs = [
    new Utxo({ amount: outputAmount }), // Combined amount minus fee
    new Utxo({ amount: '0' }) // Empty UTXO
  ];

  // Calculate extAmount (amount being deposited or withdrawn)
  // outputs - inputs + fee (same formula as in Tornado Nova)
  const inputsSum = inputs.reduce((sum, x) => sum.add(x.amount), new BN(0))
  const outputsSum = outputs.reduce((sum, x) => sum.add(x.amount), new BN(0))
  const extAmount = new BN(fee)
    .add(outputsSum)
    .sub(inputsSum)
  const publicAmount = new BN(extAmount).sub(new BN(fee)).add(FIELD_SIZE).mod(FIELD_SIZE).toString()

  console.log(`outputsSum: ${outputsSum.toString(10)}, inputsSum: ${inputsSum.toString(10)},
    extAmount: ${extAmount.toString(10)}, publicAmount: ${publicAmount}`);

  // Use the properly calculated Merkle tree root
  const root = tree.root.toString();
  
  // Resolve all async operations before creating the input object
  // Await nullifiers and commitments to get actual values instead of Promise objects
  const inputNullifiers = await Promise.all(inputs.map(x => x.getNullifier()));
  const outputCommitments = await Promise.all(outputs.map(x => x.getCommitment()));
  
  // Create extData structure following Tornado Nova approach
  // See: https://github.com/tornadocash/tornado-nova/blob/f9264eeffe48bf5e04e19d8086ee6ec58cdf0d9e/src/index.js#L61
  const extData = {
    recipient: recipient,
    extAmount: extAmount.toString(10),
    encryptedOutput1: mockEncrypt(outputs[0]),
    encryptedOutput2: mockEncrypt(outputs[1]),
  };
  
  // Generate extDataHash from the extData structure
  // See: https://github.com/tornadocash/tornado-nova/blob/f9264eeffe48bf5e04e19d8086ee6ec58cdf0d9e/src/index.js#L74
  const extDataHash = await getExtDataHash(extData);
  console.log(`Using extDataHash: ${extDataHash}`);
  
  // Following the exact input structure from Tornado Cash Nova
  // https://github.com/tornadocash/tornado-nova/blob/f9264eeffe48bf5e04e19d8086ee6ec58cdf0d9e/src/index.js#L76-L97
  const input = {
    // Common transaction data
    root: root,
    inputNullifier: inputNullifiers, // Use resolved values instead of Promise objects
    outputCommitment: outputCommitments, // Use resolved values instead of Promise objects
    publicAmount: publicAmount,
    extDataHash: extDataHash,
    
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

  // Log the input object structure for debugging
  console.log('Generating proof for inputs:', JSON.stringify(input, (key, value) => 
    BN.isBN(value) ? `<BN: ${value.toString(16)}>` : value, 2));

  // Path to the proving key files (wasm and zkey)
  // Try with both circuits to see which one works
  const keyBasePath = path.resolve(__dirname, '../artifacts/circuits/transaction2');
  
  console.log('Generating proof with inputs structured like Tornado Cash Nova...');
  console.log('Input structure:', Object.keys(input).join(', '));
  
  try {
    // Process the input with our custom preprocessor before passing to the prover
    console.log(`Using circuit files from: ${keyBasePath}`);
    console.log(`Checking files exist: ${fs.existsSync(keyBasePath + '.wasm')}, ${fs.existsSync(keyBasePath + '.zkey')}`);
    
    console.log('Sample input values:');
    console.log('- root:', input.root);
    console.log('- publicAmount:', input.publicAmount);
    console.log('- extDataHash:', input.extDataHash);
    console.log('- inAmount[0]:', input.inAmount[0]);
    console.log('- inPrivateKey[0]:', input.inPrivateKey[0]);
    console.log('- sumIns:', inputs.reduce((sum, x) => sum.add(x.amount), new BN(0)).toString(10));
    console.log('- sumOuts:', outputs.reduce((sum, x) => sum.add(x.amount), new BN(0)).toString(10));
    // console.log('- inPathIndices:', input.inPathIndices);
    // console.log('- outputCommitment:', input.outputCommitment);
    
    // Use the updated prove function that returns an object with proof components
    const {proof, publicSignals} = await prove(input, keyBasePath);
    
    console.log('Proof generated successfully!');
    console.log('Public signals:');
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
      
      console.log(`[${index}]: ${signal} (${matchedKey})`);
    });
    
    // Try verification with proper field element handling
    const processedPublicSignals = utils.unstringifyBigInts(publicSignals);
    const processedProof = utils.unstringifyBigInts(proof);

    try {
      // First attempt with processed signals
      const res = await verify(path.resolve(__dirname, "../artifacts/circuits/verifyingkey2.json"),
        processedPublicSignals, processedProof);
      console.log('!!!!!!Verification result (with processed signals):', res);
      
      return {proof, publicSignals};
    } catch (error: any) {
      console.error('Verification error:', error.message);
      console.error('This indicates a mismatch between the circuit, prover, and verification key.');
      console.log('You may need to:');
      console.log('1. Recompile the circuit after making changes to transaction2.circom');
      console.log('2. Regenerate the verification key');
      console.log('3. Make sure field element encodings are consistent');
      throw error;
    }
  } catch (error) {
    console.error('Error generating proof:', error);
    if (error instanceof Error) {
      console.error('Error details:', error.message);
      console.error('Stack trace:', error.stack);
    }
    throw error;
  }
}

/**
 * Run the sample proof generator
 */
async function main() {
  try {
    console.log('Starting sample proof generation...');
    // Always use the same values for reproducible proofs
    const options = {
      amount1: '1000000000',
      amount2: '500000000',
      blinding1: '1000000000',
      blinding2: '500000000',
      fee: '100000000',
      recipient: '0x1111111111111111111111111111111111111111',
      relayer: '0x2222222222222222222222222222222222222222'
    };
    console.log('Using fixed inputs for deterministic proofs:', JSON.stringify(options, null, 2));
    
    await generateSampleProofForWithdraw();
  } catch (error) {
    console.error('Failed to generate proof:', error);
    if (error instanceof Error) {
      console.error('Error details:', error.message);
      console.error('Stack trace:', error.stack);
    }
  }
}

// Execute if called directly
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}