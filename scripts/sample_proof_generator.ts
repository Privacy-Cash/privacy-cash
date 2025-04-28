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
import bs58 from 'bs58';
import MerkleTree from 'fixed-merkle-tree';
import { ethers } from 'ethers';
const FIELD_SIZE = new BN(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617'
)

const poseidon = require("circomlib/src/poseidon.js");

const poseidonHash = (items: any[]) => new BN(poseidon(items).toString())
const poseidonHash2ToString = (a: any, b: any) => poseidonHash([a, b]).toString();

/**
 * Calculates the Poseidon hash of ext data
 */
async function getExtDataHash(extData: any): Promise<string> {
  // Prepare inputs as array of field elements
  const inputs = [
    // For hex addresses, remove 0x prefix and convert from hex to decimal
    new BN(extData.recipient.toString().replace('0x', ''), 16),
    // For numeric values, parse directly
    new BN(extData.extAmount.toString()),
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
  return hash.toString();
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
  public privkey: BN;
  public pubkey: BN;

  constructor(privkeyHex: string) {
    const rawDecimal = BigInt(privkeyHex);
    this.privkey = new BN((rawDecimal % BigInt(FIELD_SIZE.toString())).toString());
    // TODO: lazily compute pubkey
    this.pubkey = poseidonHash([this.privkey])
  }

   /**
   * Sign a message using keypair private key
   *
   * @param {string|number|BigNumber} commitment a hex string with commitment
   * @param {string|number|BigNumber} merklePath a hex string with merkle path
   * @returns {BigNumber} a hex string with signature
   */
  sign(commitment: string, merklePath: string): string {
    return poseidonHash([this.privkey, commitment, merklePath]).toString();
  }

  static generateNew(): Keypair {
    // Tornado Cash Nova uses ethers.js to generate a random private key
    // We can't generate Solana keypairs because it won't fit in the field size
    // It's OK to use ethereum secret keys, because the secret key is only used for the proof generation.
    // Namely, it's used to guarantee the uniqueness of the nullifier.
    const wallet = ethers.Wallet.createRandom();
    return new Keypair(wallet.privateKey);
  }
}

/**
 * Simplified Utxo class inspired by Tornado Cash Nova
 * Based on: https://github.com/tornadocash/tornado-nova/blob/f9264eeffe48bf5e04e19d8086ee6ec58cdf0d9e/src/utxo.js
 */
class Utxo {
  amount: BN;
  blinding: BN;
  keypair: Keypair;
  index: number;

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
    index = 0 
  }: { 
    amount?: BN | number | string, 
    keypair?: Keypair, 
    blinding?: BN | number | string, 
    index?: number 
  }) {
    this.amount = new BN(amount.toString());
    this.blinding = new BN(blinding.toString());
    this.keypair = keypair;
    this.index = index;
  }

  async getCommitment(): Promise<string> {
    return poseidonHash([this.amount, this.keypair.pubkey, this.blinding]).toString();
  }

  async getNullifier(): Promise<string> {
    const commitmentValue = await this.getCommitment();
    const signature = this.keypair.sign(commitmentValue, new BN(this.index).toString());
    
    return poseidonHash([commitmentValue, new BN(this.index).toString(), signature]).toString();
  }
}

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
    encryptedOutput1: mockEncrypt(await outputs[0].getCommitment()),
    encryptedOutput2: mockEncrypt(await outputs[1].getCommitment()),
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
    
    await generateSampleProofForFirstDeposit();
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