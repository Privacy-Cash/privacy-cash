import { Keypair } from '@solana/web3.js';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { EncryptionService } from './utils/encryption';
import { WasmFactory } from '@lightprotocol/hasher.rs';
import { Keypair as UtxoKeypair } from './models/keypair';

dotenv.config();

/**
 * Script to decrypt a specific encrypted UTXO
 * @param encryptedHex Hex string of the encrypted UTXO to decrypt
 */
async function decryptSpecificUtxo(encryptedHex: string) {
  try {
    // Initialize the light protocol hasher
    const lightWasm = await WasmFactory.getInstance();
    
    // Initialize the encryption service
    const encryptionService = new EncryptionService();
    
    // Load wallet keypair from deploy-keypair.json in anchor directory
    let keypair: Keypair;
    
    try {
      // Try to load from deploy-keypair.json in anchor directory
      const anchorDirPath = path.join(__dirname, '..', 'anchor');
      const deployKeypairPath = path.join(anchorDirPath, 'deploy-keypair.json');
      const keypairJson = JSON.parse(readFileSync(deployKeypairPath, 'utf-8'));
      keypair = Keypair.fromSecretKey(Uint8Array.from(keypairJson));
      console.log('Using deploy keypair from anchor directory');
      
      // Generate encryption key from the payer keypair
      encryptionService.deriveEncryptionKeyFromWallet(keypair);
      console.log('Encryption key generated');
    } catch (err) {
      console.error('Could not load deploy-keypair.json from anchor directory');
      return;
    }

    console.log(`\nDecrypting UTXO: ${encryptedHex}`);
    
    try {
      // Convert hex string to Buffer
      const encryptedBuffer = Buffer.from(encryptedHex, 'hex');
      
      // Decrypt the data (show the raw data first)
      const rawDecrypted = encryptionService.decrypt(encryptedBuffer);
      console.log(`Raw decrypted data: ${rawDecrypted.toString()}`);
      
      // Parse the raw data if it's pipe-delimited
      const rawParts = rawDecrypted.toString().split('|');
      console.log('Parsed components:');
      console.log('- Amount:', rawParts[0]);
      console.log('- Blinding:', rawParts[1]);
      console.log('- Index:', rawParts[2]);
      
      // Derive the UTXO keypair from the wallet keypair
      const utxoPrivateKey = encryptionService.deriveUtxoPrivateKey();
      const utxoKeypair = new UtxoKeypair(utxoPrivateKey, lightWasm);
      console.log('Using wallet-derived UTXO keypair for decryption');
      
      // Now try to parse it as a UTXO
      console.log('\nCreating UTXO object from decrypted data...');
      const utxo = await encryptionService.decryptUtxo(encryptedBuffer, utxoKeypair, lightWasm);
      
      // Use the log method to display UTXO details in JSON format
      console.log('\nDecrypted UTXO details:');
      await utxo.log();
      
      // Show derived cryptographic values
      console.log('\nCryptographic values:');
      const commitment = await utxo.getCommitment();
      const nullifier = await utxo.getNullifier();
      console.log('- Commitment:', commitment);
      console.log('- Nullifier:', nullifier);
      
    } catch (error: any) {
      console.error('Failed to decrypt UTXO:', error.message);
    }
  } catch (error: any) {
    console.error('Script error:', error);
  }
}

decryptSpecificUtxo("e7d635b63f7b2661bf00240f85d0de2ad17e094743aaf6e5fb26dabc38e596191c8aac0a685dfef6d08681f7c7")
    .then(() => console.log('\nDecryption completed'))
    .catch(err => console.error('Error running script:', err));