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
import { buildPoseidon } from "circomlibjs";
import { utils } from 'ffjavascript';
import bs58 from 'bs58';
import MerkleTree from 'fixed-merkle-tree';
import * as ethers from 'ethers';

const FIELD_SIZE = new BN(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617'
)

/**
 * Calculates the Poseidon hash of ext data
 */
async function getExtDataHash(extData: any): Promise<string> {
  // Initialize Poseidon hasher
  const poseidon = await buildPoseidon();
  
  // Prepare inputs as array of field elements
  const inputs = [
    // For hex addresses, remove 0x prefix and convert from hex to decimal
    new BN(extData.recipient.toString().replace('0x', ''), 16),
    // For numeric values, parse directly
    new BN(extData.extAmount.toString()),
    // For hex addresses, remove 0x prefix and convert from hex to decimal
    new BN(extData.relayer.toString().replace('0x', ''), 16),
    new BN(extData.fee.toString()),
    // For encrypted outputs, use a deterministic numeric representation
    new BN(extData.encryptedOutput1.toString().split('').map((c: string) => c.charCodeAt(0).toString(16)).join(''), 16),
    new BN(extData.encryptedOutput2.toString().split('').map((c: string) => c.charCodeAt(0).toString(16)).join(''), 16)
  ];
  
  // Convert BNs to BigInts for Poseidon
  const bigIntInputs = inputs.map(bn => BigInt(bn.toString()));
  
  // Log the inputs for debugging
  console.log('Poseidon inputs:', bigIntInputs.map(n => n.toString()));
  
  // Calculate the Poseidon hash
  const hash = poseidon(bigIntInputs);
  
  // Convert the hash to a field element string (poseidon already ensures it's in the field)
  const hashStr = poseidon.F.toString(hash);
  
  // Return the result as a string directly without additional modulo
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

  constructor(privkey?: string) {
    if (privkey) {
      this.privkey = privkey;
      // Derive pubkey from private key (simplified for this example)
      this.pubkey = Buffer.from(this.privkey).toString('hex').substring(0, 20);
    } else {
      // Use the loaded test keypair
      this.pubkey = TEST_KEYPAIR.pubkey;
      this.privkey = TEST_KEYPAIR.privkey;
    }
  }

  getPrivateKeyAsBigInt(): BN {
    const privateKeyBytes = bs58.decode(this.privkey);
    const privateKeyHex = Buffer.from(privateKeyBytes).toString('hex');
    const privateKeyBigInt = BigInt('0x' + privateKeyHex);
    return new BN(privateKeyBigInt.toString());
  }

  static generateNew(): Keypair {
    // Use ethers.js to generate a random wallet
    const wallet = ethers.Wallet.createRandom();
    // Convert the private key to bs58 format
    const privateKeyHex = wallet.privateKey.slice(2); // Remove '0x' prefix
    const privateKeyBytes = Buffer.from(privateKeyHex, 'hex');
    const privateKey = bs58.encode(privateKeyBytes);
    return new Keypair(privateKey);
  }
}

// Create a singleton instance of the keypair to use across all UTXOs
const DEFAULT_KEYPAIR = new Keypair();

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
    /**
     * Tornado nova doesn't use solana eddsa with curve 25519 but their own "keypair"
     * which is:
     * - private key: random [31;u8]
     * - public key: PoseidonHash(privateKey)
     * 
     * Generate a new keypair for each UTXO
     */
    keypair = Keypair.generateNew(), 
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
 * Format an array as a compact string representation
 * Removes all spaces to keep it as a single line in any terminal
 */
function formatCompactArray(arr: number[]): string {
  return `[${arr.join(',')}]`;
}

/**
 * Generates a sample ZK proof using the main proving method
 * 
 * @param options Optional parameters for the proof generation
 * @returns A promise that resolves to an object containing the proof components and public inputs
 */
async function generateSampleProof(options: {
  amount1?: string,
  amount2?: string,
  blinding1?: string | BN,
  blinding2?: string | BN,
  fee?: string,
  recipient?: string,
  relayer?: string
} = {}): Promise<{
  // proofA: Uint8Array;
  // proofB: Uint8Array;
  // proofC: Uint8Array;
  // publicSignals: Uint8Array[];
}> {
  console.log('Using test keypair with pubkey:', TEST_KEYPAIR.pubkey.substring(0, 20) + '...');
  
  // Use provided values or defaults
  const amount1 = options.amount1 || '1000000000'; // 1 SOL in lamports
  const amount2 = options.amount2 || '100000000';  // 0.5 SOL in lamports
  const blinding1 = options.blinding1 ? new BN(options.blinding1.toString()) : new BN('1000000000'); // Use fixed value for consistency
  const blinding2 = options.blinding2 ? new BN(options.blinding2.toString()) : new BN('500000000');  // Use fixed value for consistency
  const fee = options.fee || '100000000'; // Default 0.1 SOL fee
  const recipient = options.recipient || '0x1111111111111111111111111111111111111111'; // Default recipient address
  const relayer = options.relayer || '0x2222222222222222222222222222222222222222';   // Default relayer address

  // Initialize Poseidon hasher first
  const poseidon = await buildPoseidon();
  
  // Create Tornado-style poseidon hash functions
  const poseidonHash = (items: any[]) => {
    // Convert inputs to BigInts if they're not already
    const bigIntInputs = items.map(item => {
      if (typeof item === 'string') {
        return BigInt(item);
      } else if (typeof item === 'number') {
        return BigInt(item);
      } else if (BN.isBN(item)) {
        return BigInt(item.toString());
      }
      return item; // Assume it's already a BigInt
    });
    
    // Calculate hash and convert to proper field element string
    const hash = poseidon(bigIntInputs);
    return poseidon.F.toString(hash);
  };
  
  const poseidonHash2 = (a: any, b: any) => poseidonHash([a, b]);
  
  // Create the merkle tree with the pre-initialized poseidon hash
  const tree = new MerkleTree(20, [], {
    hashFunction: poseidonHash2,
    zeroElement: 11850551329423159860688778991827824730037759162201783566284850822760196767874
  });
  
  // Log the root in decimal
  console.log(`Merkle tree root (decimal): ${tree.root.toString()}`);
  console.log(`Merkle tree root (hex): 0x${BigInt(tree.root.toString()).toString(16)}`);
  
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
    currentZero = poseidonHash2(currentZero, currentZero);
  }
  
  // Create the Merkle paths for each input
  const inputMerklePathElements = inputs.map(() => {
    // Return an array of zero elements as the path for each input
    // Create a copy of the zeroElements array to avoid modifying the original
    return [...zeroElements];
  });

  // Use the properly calculated Merkle tree root
  const root = tree.root.toString();
  
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
    inPrivateKey: inputs.map(x => x.keypair.getPrivateKeyAsBigInt()),
    inBlinding: inputs.map(x => x.blinding.toString(10)),
    inPathIndices: inputMerklePathIndices,
    // inPathElements: inputMerklePathElements,
    
    // Output UTXO data (UTXOs being created) - ensure all values are in decimal format
    outAmount: outputs.map(x => x.amount.toString(10)),
    // outBlinding: outputs.map(x => x.blinding.toString(10)),
    // outPubkey: outputs.map(x => x.keypair.pubkey),
  };

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
      console.log('!!!!!!Verification result 1 (with processed signals):', res);
      
      if (!res) {
        // Try alternative verification directly with the original values
        console.log('Attempting alternative verification approach...');
        
        // Try with original signals without processing
        const res2 = await verify(path.resolve(__dirname, "../artifacts/circuits/verifyingkey2.json"),
          publicSignals, proof);
        console.log('!!!!!!Verification result 2 (with original signals):', res2);
        
        // Check verification key path
        console.log('Verification key path:', path.resolve(__dirname, "../artifacts/circuits/verifyingkey2.json"));
        console.log('Verification key exists:', fs.existsSync(path.resolve(__dirname, "../artifacts/circuits/verifyingkey2.json")));
      }
      
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
    
    await generateSampleProof(options);
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