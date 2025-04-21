/**
 * Sample Proof Generator
 * 
 * Demonstrates how to use the prover module to generate zero-knowledge proofs
 * with appropriate sample inputs for testing purposes.
 * Based on: https://github.com/tornadocash/tornado-nova
 */

/// <reference path="./types.d.ts" />

import { prove } from './prover';
import BN from 'bn.js';
import * as fs from 'fs';
import * as path from 'path';
import { buildPoseidon } from "circomlibjs";

/**
 * Converts a number to a fixed-length hex string
 */
function toFixedHex(number: any, length = 32): string {
  let result =
    '0x' +
    (number instanceof Buffer
      ? number.toString('hex')
      : new BN(number).toString('hex')
    ).padStart(length * 2, '0');
  if (result.indexOf('-') > -1) {
    result = '-' + result.replace('-', '');
  }
  return result;
}

/**
 * Converts a string or BN to a 32-byte array with big-endian representation
 */
function toBigEndianBytes(value: string | BN): Uint8Array {
  let bnValue: BN;
  
  // Convert to BN if it's a string
  if (typeof value === 'string') {
    // If it's a hex string, convert from hex
    if (value.startsWith('0x')) {
      bnValue = new BN(value.slice(2), 16);
    } else {
      // Otherwise treat as decimal
      bnValue = new BN(value, 10);
    }
  } else {
    bnValue = value;
  }
  
  // Convert to big-endian bytes and pad to 32 bytes
  const hex = bnValue.toString(16).padStart(64, '0');
  const bytes = new Uint8Array(32);
  
  // Fill the byte array
  for (let i = 0; i < 32; i++) {
    const idx = i * 2;
    if (idx < hex.length) {
      bytes[i] = parseInt(hex.slice(idx, idx + 2), 16);
    }
  }
  
  return bytes;
}

/**
 * Formats byte arrays as a Rust-style array declaration
 * Matches the exact format used in the groth16_test.rs file
 */
function formatAsRustByteArrays(arrays: number[][]): string {
  return `pub const PUBLIC_INPUTS: [[u8; 32]; ${arrays.length}] = [
${arrays.map(arr => {
  // Group bytes into lines of ~20 numbers each for readability
  const lines = [];
  let line = '';
  for (let i = 0; i < arr.length; i++) {
    line += arr[i] + ', ';
    // Start a new line every ~20 numbers
    if ((i + 1) % 20 === 0 || i === arr.length - 1) {
      lines.push(line.trim());
      line = '';
    }
  }
  return `    [
        ${lines.join('\n        ')}
    ]`;
}).join(',\n')}
];`;
}

/**
 * Calculates the Poseidon hash of ext data, similar to keccak256 in Ethereum implementation
 */
async function getExtDataHash(extData: any): Promise<string> {
  // Initialize Poseidon hasher
  const poseidon = await buildPoseidon();
  
  // Prepare inputs as array of field elements
  // Handle different formats correctly and ensure deterministic behavior
  const inputs = [
    // For hex addresses, remove 0x prefix and convert from hex to decimal
    new BN(extData.recipient.toString().replace('0x', ''), 16),
    // For numeric values, parse directly
    new BN(extData.extAmount.toString()),
    // For hex addresses, remove 0x prefix and convert from hex to decimal
    new BN(extData.relayer.toString().replace('0x', ''), 16),
    new BN(extData.fee.toString()),
    // For encrypted outputs, use a deterministic numeric representation
    // Instead of using Buffer, directly convert string to a numeric value
    new BN(extData.encryptedOutput1.toString().split('').map((c: string) => c.charCodeAt(0).toString(16)).join(''), 16),
    new BN(extData.encryptedOutput2.toString().split('').map((c: string) => c.charCodeAt(0).toString(16)).join(''), 16)
  ];
  
  // Convert BNs to BigInts for Poseidon
  const bigIntInputs = inputs.map(bn => BigInt(bn.toString()));
  
  // Log the exact inputs going into the hasher for debugging
  console.log('Poseidon hash inputs:', bigIntInputs.map(n => n.toString()));
  
  // Calculate the Poseidon hash
  const hash = poseidon(bigIntInputs);
  
  // Convert the hash result to a string
  const hashStr = poseidon.F.toString(hash);
  
  return hashStr;
}

/**
 * Simple encryption mock - in real implementation this would be proper encryption
 * For testing, we just return a fixed prefix to ensure consistent extDataHash
 */
function mockEncrypt(value: string): string {
  return 'enc_' + value;
}

/**
 * Load keypair from test-keypair.json
 */
function loadTestKeypair(): { pubkey: string, privkey: string } {
  try {
    const keypairPath = path.join(__dirname, 'test-keypair.json');
    const keypairJson = fs.readFileSync(keypairPath, 'utf8');
    return JSON.parse(keypairJson);
  } catch (error) {
    console.error('Failed to load test-keypair.json:', error);
    throw new Error('Failed to load test-keypair.json. Make sure the file exists in the scripts directory.');
  }
}

// Initialize the test keypair from the JSON file
const TEST_KEYPAIR = loadTestKeypair();
console.log('Loaded test keypair from test-keypair.json');
console.log('Using pubkey:', TEST_KEYPAIR.pubkey.substring(0, 10) + '...');

/**
 * Simplified version of Keypair
 */
class Keypair {
  pubkey: string;
  privkey: string;

  constructor() {
    // Use the loaded test keypair
    this.pubkey = TEST_KEYPAIR.pubkey;
    this.privkey = TEST_KEYPAIR.privkey;
  }
}

// Create a singleton instance of the keypair to use across all UTXOs
const DEFAULT_KEYPAIR = new Keypair();

/**
 * Prepares input data for the circuit by ensuring all values are properly formatted
 * This helps avoid BigInt conversion issues
 */
function prepareInputForCircuit(input: any): any {
  // Deep clone to avoid mutating the original input
  const preparedInput = JSON.parse(JSON.stringify(input));
  
  // Recursively process all values
  function processValue(value: any): any {
    if (typeof value === 'string') {
      // If it looks like a hex string without 0x prefix, convert to decimal
      if (/^[0-9a-fA-F]+$/.test(value) && value.length > 8) {
        try {
          return new BN(value, 16).toString(10);
        } catch (e) {
          // If conversion fails, return the original value
          return value;
        }
      }
      return value;
    } else if (Array.isArray(value)) {
      return value.map(processValue);
    } else if (value !== null && typeof value === 'object') {
      const result: any = {};
      for (const key in value) {
        result[key] = processValue(value[key]);
      }
      return result;
    }
    return value;
  }
  
  return processValue(preparedInput);
}

/**
 * Simplified Utxo class inspired by Tornado Cash Nova
 * Based on: https://github.com/tornadocash/tornado-nova/blob/f9264eeffe48bf5e04e19d8086ee6ec58cdf0d9e/src/utxo.js
 */
class Utxo {
  amount: BN;
  blinding: BN;
  keypair: Keypair;
  index: number | null;

  constructor({ 
    amount = new BN(0), 
    keypair = DEFAULT_KEYPAIR, 
    blinding = new BN('1000000000'), // Use fixed value for consistency instead of randomBN()
    index = null 
  }: { 
    amount?: BN | number | string, 
    keypair?: Keypair, 
    blinding?: BN | number | string, 
    index?: number | null 
  }) {
    this.amount = new BN(amount.toString());
    this.blinding = new BN(blinding.toString());
    this.keypair = keypair;
    this.index = index;
  }

  getCommitment(): string {
    // In the real implementation this would hash [amount, pubkey, blinding]
    // Here we create a deterministic value for testing
    const amountStr = this.amount.toString(10);
    const pubkeyNum = this.keypair.pubkey.split('').reduce((acc: number, char: string) => acc + char.charCodeAt(0), 0);
    const blinding = this.blinding.toString(10);
    
    // Use BN instead of parseInt to handle large numbers consistently
    const amountBN = new BN(amountStr);
    const pubkeyBN = new BN(pubkeyNum);
    const blindingBN = new BN(blinding);
    
    // Add using BN methods for consistent and deterministic results
    const combined = amountBN.add(pubkeyBN).add(blindingBN);
    
    // Return the result as a string
    return combined.toString(10);
  }

  getNullifier(): string {
    // In the real implementation this would be a complex hash 
    // Here we create a deterministic value for testing
    const commitmentValue = this.getCommitment();
    const indexValue = this.index || 0;
    
    // Use BN instead of parseInt to handle large numbers consistently
    const commitmentBN = new BN(commitmentValue);
    const indexBN = new BN(indexValue);
    
    // Add using BN methods for consistent and deterministic results
    const result = commitmentBN.add(indexBN);
    
    // Return the result as a string
    return result.toString(10);
  }
}

/**
 * Generates a sample ZK proof using the main proving method
 * 
 * @param options Optional parameters for the proof generation
 * @returns A promise that resolves to an object containing the proof byte array and public inputs
 */
async function generateSampleProof(options: {
  amount1?: string,
  amount2?: string,
  blinding1?: string | BN,
  blinding2?: string | BN,
  fee?: string,
  recipient?: string,
  relayer?: string
} = {}): Promise<{ proof: number[], publicInputs: number[][] }> {
  console.log('Using test keypair with pubkey:', TEST_KEYPAIR.pubkey.substring(0, 20) + '...');
  
  // Use provided values or defaults
  const amount1 = options.amount1 || '1000000000'; // 1 SOL in lamports
  const amount2 = options.amount2 || '100000000';  // 0.5 SOL in lamports
  const blinding1 = options.blinding1 ? new BN(options.blinding1.toString()) : new BN('1000000000'); // Use fixed value for consistency
  const blinding2 = options.blinding2 ? new BN(options.blinding2.toString()) : new BN('500000000');  // Use fixed value for consistency
  const fee = options.fee || '100000000'; // Default 0.1 SOL fee
  const recipient = options.recipient || '0x1111111111111111111111111111111111111111'; // Default recipient address
  const relayer = options.relayer || '0x2222222222222222222222222222222222222222';   // Default relayer address
  
  console.log(`Using amounts: ${amount1}, ${amount2}`);
  console.log(`Using blinding factors: ${blinding1.toString(10).substring(0, 10)}..., ${blinding2.toString(10).substring(0, 10)}...`);

  // Create inputs (UTXOs that are being spent)
  const inputs = [
    new Utxo({ 
      amount: amount1,
      blinding: blinding1,
      index: 0
    }),
    new Utxo({ 
      amount: amount2,
      blinding: blinding2,
      index: 1
    })
  ];

  // Create outputs (UTXOs that are being created)
  const outputAmount = '2900000000'; // Subtract fee
  const outputs = [
    new Utxo({ amount: outputAmount }), // Combined amount minus fee
    new Utxo({ amount: '0' }) // Empty UTXO
  ];

  // Calculate extAmount (amount being deposited or withdrawn)
  // outputs - inputs + fee (same formula as in Tornado Nova)
  const outputsSum = outputs.reduce((sum, x) => sum.add(x.amount), new BN(0));
  const inputsSum = inputs.reduce((sum, x) => sum.add(x.amount), new BN(0));
  const extAmount = outputsSum.sub(inputsSum).add(new BN(fee));
  const publicAmount = extAmount.toString(10);

  console.log(`outputsSum: ${outputsSum.toString(10)}, inputsSum: ${inputsSum.toString(10)},
    extAmount: ${extAmount.toString(10)}, publicAmount: ${publicAmount}`);

  // Create mock Merkle path data (normally built from the tree)
  const inputMerklePathIndices = inputs.map((input) => input.index || 0);
  const inputMerklePathElements = inputs.map(() => {
    return [
      '14897476871511737208931101624454160146487338617261778552768757778567922609957', 
      '11065032086434745150434600392406097478262460959173502027269731908506534612166',
      '7063717813858192909384753650399516649568754120595406505542418585608798093572',
      '3352960798171081805132557483734353395757811113441681938313497614205113992983'
    ];
  });

  // Construct the root (normally derived from the Merkle tree)
  const root = '14897476871511737208931101624454160146487338617261778552768757778567922609957';
  
  // Create extData structure following Tornado Nova approach
  // See: https://github.com/tornadocash/tornado-nova/blob/f9264eeffe48bf5e04e19d8086ee6ec58cdf0d9e/src/index.js#L61
  const extData = {
    recipient: recipient,
    extAmount: extAmount.toString(10),
    relayer: relayer,
    fee: fee,
    encryptedOutput1: mockEncrypt(outputs[0].getCommitment()),
    encryptedOutput2: mockEncrypt(outputs[1].getCommitment()),
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
    inputNullifier: inputs.map(x => x.getNullifier()),
    outputCommitment: outputs.map(x => x.getCommitment()),
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

  // Path to the proving key files (wasm and zkey)
  const keyBasePath = path.resolve(__dirname, '../artifacts/circuits/transaction2');
  
  console.log('Generating proof with inputs structured like Tornado Cash Nova...');
  console.log('Input structure:', Object.keys(input).join(', '));
  
  try {
    // Process the input with our custom preprocessor before passing to the prover
    console.log(`Using circuit files from: ${keyBasePath}`);
    console.log(`Checking files exist: ${fs.existsSync(keyBasePath + '.wasm')}, ${fs.existsSync(keyBasePath + '.zkey')}`);
    
    console.log('Sample input values:');
    console.log('- inAmount[0]:', input.inAmount[0]);
    console.log('- inPrivateKey[0]:', input.inPrivateKey[0].substring(0, 20) + '...');
    console.log('- outPubkey[0]:', input.outPubkey[0].substring(0, 20) + '...');
    
    // Preprocess the input to ensure all values are properly formatted
    const processedInput = prepareInputForCircuit(input);
    
    // Use the original prove function with only the expected parameters
    const proof = await prove(processedInput, keyBasePath);
    console.log('Proof generated successfully!');
    console.log('Proof hex:', proof);
    
    // Convert the proof to a byte array
    const proofByteArray = hexToByteArray(proof);
    console.log(`Proof as byte array: [${proofByteArray.join(', ')}]`);

    // Extract public inputs similar to the PUBLIC_INPUTS format in the Rust test file
    // The Rust test expects 9 public inputs, each as a 32-byte array
    const publicInputs: number[][] = [];
    
    // 1. Root
    publicInputs.push([...toBigEndianBytes(input.root)]);
    
    // 2-3. InputNullifiers (2 inputs)
    for (const nullifier of input.inputNullifier) {
      publicInputs.push([...toBigEndianBytes(nullifier)]);
    }
    
    // 4-5. OutputCommitments (2 outputs)
    for (const commitment of input.outputCommitment) {
      publicInputs.push([...toBigEndianBytes(commitment)]);
    }
    
    // 6. PublicAmount (extAmount)
    publicInputs.push([...toBigEndianBytes(input.publicAmount)]);
    
    // 7. ExtDataHash
    publicInputs.push([...toBigEndianBytes(input.extDataHash)]);
    
    // Log the public inputs for debugging
    console.log('Generated public inputs:');
    publicInputs.forEach((input, i) => {
      console.log(`Public input ${i}: [${input.join(', ')}]`);
    });
    
    // Format the public inputs as a Rust array declaration (exactly matching Rust test format)
    const rustPublicInputs = formatAsRustByteArrays(publicInputs);
    console.log('Rust PUBLIC_INPUTS declaration:');
    console.log(rustPublicInputs);
    
    return { 
      proof: proofByteArray,
      publicInputs: publicInputs
    };
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
    
    const { proof, publicInputs } = await generateSampleProof(options);
    console.log('Proof generation completed successfully!');
    
    // Output the Rust code for both the proof and public inputs in the exact format used in tests
    console.log('\nRust constant declarations:');
    console.log(`pub const PROOF: [u8; ${proof.length}] = [${proof.join(', ')}];`);
    
    // Use the formatter for exact match with test file format
    console.log('\n' + formatAsRustByteArrays(publicInputs));
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

export { generateSampleProof };

function hexToByteArray(hexString: string): number[] {
  // Remove the '0x' prefix if present
  if (hexString.startsWith('0x')) {
    hexString = hexString.slice(2);
  }

  // Convert hex string to byte array
  const byteArray: number[] = [];
  for (let i = 0; i < hexString.length; i += 2) {
    const byte = parseInt(hexString.substr(i, 2), 16);
    byteArray.push(byte);
  }

  return byteArray;
}

// Your hex string
const hexProof = "030e9125d70e3e5298bc495978ddb4803ad51d5854355a366694a77add213331125a20bcbe76c5398e351b2e78034b1cbfee080603db32aa56f93833f40ea66a0512831a2e53e95d914c1d9c9e138ddf76b35f28861837b549b0545d09e334fa0afc06903e839f7763f9560c48b0c82de7e8c457a85ea00ff2cc8c284579a2501374b16e70cd762a2b5994b8bac6a8abd06196fcb2bf4b83a2493271d263cc3f00151ddd2c0af67cb47611974af8e576dc59addda85eced8a0c8569ecd6967df07629e24f6ce7c77c301baf0def9bdd1825e1dad0dd6964407e329983b90496a0270fe50a827d56456f4563cb696c534f0edde50e7a993a4ca03148fa753f362";

// Convert and print the byte array
const byteArray = hexToByteArray(hexProof);
console.log(`pub const PROOF: [u8; ${byteArray.length}] = [${byteArray.join(', ')}];`);
