import { Keypair } from '@solana/web3.js';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { EncryptionService } from './utils/encryption';
import { WasmFactory } from '@lightprotocol/hasher.rs';
import { Keypair as UtxoKeypair } from './models/keypair';
import { Utxo } from './models/utxo';
import axios from 'axios';
import { Connection, PublicKey } from '@solana/web3.js';

dotenv.config();

// Program ID for the zkcash program - same as in deposit_devnet.ts
const PROGRAM_ID = new PublicKey('BByY3XVe36QEn3omkkzZM7rst2mKqt4S4XMCrbM9oUTh');

/**
 * Interface for the UTXO data returned from the API
 */
interface ApiUtxo {
  commitment: string;
  encrypted_output: string; // Hex-encoded encrypted UTXO data
  index: number;
  nullifier?: string; // Optional, might not be present for all UTXOs
}

/**
 * Interface for the API response format that includes count and encrypted_outputs
 */
interface ApiResponse {
  count: number;
  encrypted_outputs: string[];
}

/**
 * Fetch and decrypt all UTXOs for a user
 * @param keypair The user's Solana keypair
 * @param apiUrl Optional custom API URL, defaults to 'https://api.thelive.bet/utxos'
 * @returns Array of decrypted UTXOs that belong to the user
 */
export async function getMyUtxos(keypair: Keypair, apiUrl?: string): Promise<Utxo[]> {
  try {
    // Initialize the light protocol hasher
    const lightWasm = await WasmFactory.getInstance();
    
    // Initialize the encryption service and generate encryption key from the keypair
    const encryptionService = new EncryptionService();
    encryptionService.deriveEncryptionKeyFromWallet(keypair);
    
    // Derive the UTXO keypair from the wallet keypair
    const utxoPrivateKey = encryptionService.deriveUtxoPrivateKey();
    const utxoKeypair = new UtxoKeypair(utxoPrivateKey, lightWasm);
    
    console.log(`Fetching UTXOs for address: ${keypair.publicKey.toBase58()}`);
    
    // Use default API URL if not provided
    const url = apiUrl || 'https://api.thelive.bet/utxos';
    console.log(`Using API endpoint: ${url}`);
    
    // Fetch all UTXOs from the API
    let encryptedOutputs: string[] = [];
    
    try {
      const response = await axios.get(url);
      
      // Log the raw response for debugging
      console.log(`API Response status: ${response.status}`);
      console.log(`Response type: ${typeof response.data}`);
      
      if (!response.data) {
        console.error('API returned empty data');
      } else if (Array.isArray(response.data)) {
        // Handle the case where the API returns an array of UTXOs
        const utxos: ApiUtxo[] = response.data;
        console.log(`Found ${utxos.length} total UTXOs in the system (array format)`);
        
        // Extract encrypted outputs from the array of UTXOs
        encryptedOutputs = utxos
          .filter(utxo => utxo.encrypted_output)
          .map(utxo => utxo.encrypted_output);
      } else if (typeof response.data === 'object' && response.data.encrypted_outputs) {
        // Handle the case where the API returns an object with encrypted_outputs array
        const apiResponse = response.data as ApiResponse;
        encryptedOutputs = apiResponse.encrypted_outputs;
        console.log(`Found ${apiResponse.count} total UTXOs in the system (object format)`);
      } else {
        console.error(`API returned unexpected data format: ${JSON.stringify(response.data).substring(0, 100)}...`);
      }
      
      // Log all encrypted outputs line by line
      console.log('\n=== ALL ENCRYPTED OUTPUTS ===');
      encryptedOutputs.forEach((output, index) => {
        console.log(`[${index + 1}] ${output}`);
      });
      console.log(`=== END OF ENCRYPTED OUTPUTS (${encryptedOutputs.length} total) ===\n`);
      
    } catch (apiError: any) {
      console.error(`API request failed: ${apiError.message}`);
    }
    
    // Try to decrypt each encrypted output
    const myUtxos: Utxo[] = [];
    
    console.log('Attempting to decrypt UTXOs...');
    let decryptionAttempts = 0;
    let successfulDecryptions = 0;
    
    for (let i = 0; i < encryptedOutputs.length; i++) {
      const encryptedOutput = encryptedOutputs[i];
      try {
        if (!encryptedOutput) {
          console.log(`Skipping empty encrypted output at index ${i}`);
          continue;
        }
        
        decryptionAttempts++;
        console.log(`Attempting decryption of encrypted output #${i + 1}...`);
        
        // Try to decrypt the UTXO
        const decryptedUtxo = await encryptionService.decryptUtxo(
          encryptedOutput,
          utxoKeypair,
          lightWasm
        );
        
        // If we got here, decryption succeeded, so this UTXO belongs to the user
        successfulDecryptions++;
        console.log(`✓ Successfully decrypted output #${i + 1}`);
        
        // Set the index (since we don't have exact index information)
        decryptedUtxo.index = i;
        
        // Add to our list of UTXOs
        myUtxos.push(decryptedUtxo);
      } catch (error: any) {
        // Log error but continue - this UTXO doesn't belong to the user
        console.log(`✗ Failed to decrypt output #${i + 1}: ${error.message.split('\n')[0]}`);
        continue;
      }
    }
    
    console.log(`\nDecryption summary: ${successfulDecryptions} successful out of ${decryptionAttempts} attempts`);
    console.log(`Found ${myUtxos.length} UTXOs belonging to your keypair in ${encryptedOutputs.length} total UTXOs`);
    return myUtxos;
  } catch (error: any) {
    console.error('Error fetching UTXOs:', error.message);
    return [];
  }
}

/**
 * Check if a UTXO has been spent
 * @param connection Solana connection
 * @param utxo The UTXO to check
 * @returns Promise<boolean> true if spent, false if unspent
 */
export async function isUtxoSpent(connection: Connection, utxo: Utxo): Promise<boolean> {
  try {
    // Get the nullifier for this UTXO
    const nullifier = await utxo.getNullifier();
    console.log(`Checking if UTXO with nullifier ${nullifier} is spent`);
    
    // Looking at the Rust code and how it uses nullifiers, we need to use the raw bytes of the nullifier
    // for PDA derivation. We'll use a simpler approach than the previous one, leveraging
    // the fact that Solana already has seeds limited to 32 bytes.
    
    // Use a hex hash of the nullifier instead of the raw value to keep the seed size manageable
    const crypto = require('crypto');
    const nullifierHash = crypto.createHash('sha256').update(nullifier).digest();
    
    // Now use this hash for the PDA derivation
    const [nullifierPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("nullifier0"), nullifierHash],
      PROGRAM_ID
    );
    
    console.log(`Derived nullifier PDA: ${nullifierPda.toBase58()}`);
    
    // Check if this account exists
    const nullifierAccount = await connection.getAccountInfo(nullifierPda);
    
    // If the account exists, the UTXO has been spent
    const isSpent = nullifierAccount !== null;
    console.log(`UTXO is ${isSpent ? 'spent' : 'unspent'}`);
    
    return isSpent;
  } catch (error) {
    console.error('Error checking if UTXO is spent:', error);
    return false; // Default to unspent in case of errors
  }
}

/**
 * Sample usage: Load a keypair from file and fetch all UTXOs
 */
async function main() {
  try {
    // Load keypair from script_keypair.json
    let keypair: Keypair;
    
    try {
      // First try to load from script_keypair.json
      const scriptKeypairPath = path.join(__dirname, 'script_keypair.json');
      const keypairJson = JSON.parse(readFileSync(scriptKeypairPath, 'utf-8'));
      keypair = Keypair.fromSecretKey(Uint8Array.from(keypairJson));
      console.log('Using script_keypair.json');
    } catch (err) {
      console.log('Could not load script_keypair.json, falling back to deploy-keypair.json');
      return;
    }
    
    console.log('Using keypair with public key:', keypair.publicKey.toBase58());
    
    // Check for custom API URL in .env file
    const apiUrl = process.env.UTXO_API_URL;
    
    // Fetch all UTXOs for this keypair
    const myUtxos = await getMyUtxos(keypair, apiUrl);
    
    // Display them
    console.log('\nYour UTXOs:');
    if (myUtxos.length === 0) {
      console.log('No UTXOs found for this keypair.');
    } else {
      // Connect to Solana once instead of for each UTXO
      const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com');
      
      for (const utxo of myUtxos) {
        await utxo.log();
        
        const isSpent = await isUtxoSpent(connection, utxo);
        console.log(`UTXO status: ${isSpent ? 'SPENT' : 'UNSPENT'}`);
        console.log('------------------------');
      }
    }
    
    console.log(`\nTotal UTXOs found: ${myUtxos.length}`);
  } catch (error: any) {
    console.error('Error in main function:', error.message);
  }
}

// Run the main function if this script is executed directly
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
} 