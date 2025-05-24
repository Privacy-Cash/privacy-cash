import { Keypair } from '@solana/web3.js';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { EncryptionService } from './utils/encryption';
import { WasmFactory } from '@lightprotocol/hasher.rs';

dotenv.config();

/**
 * Script to decrypt a specific encrypted UTXO
 */
async function decryptSpecificUtxo() {
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
      encryptionService.generateEncryptionKey(keypair);
      console.log('Encryption key generated from wallet keypair');
    } catch (err) {
      console.error('Could not load deploy-keypair.json from anchor directory');
      return;
    }

    // The specific encrypted UTXO to decrypt
    const encryptedUtxoHex = '5e3ff771fd646662cfa7cfa6730c806b1432caacd93783ddcf30ae287f065372df009c8486871cfaa872ada2779e47fdb2a6de688e';
    
    console.log(`Attempting to decrypt: ${encryptedUtxoHex}`);
    console.log(`Hex length: ${encryptedUtxoHex.length} characters (${encryptedUtxoHex.length/2} bytes)`);
    
    try {
      // Convert hex string to Buffer
      const encryptedBuffer = Buffer.from(encryptedUtxoHex, 'hex');
      console.log(`Buffer length: ${encryptedBuffer.length} bytes`);
      
      // Try to decrypt as a UtxoData first (the simpler format)
      try {
        // Use decrypt directly first to see the raw data
        const rawDecrypted = encryptionService.decrypt(encryptedBuffer);
        console.log(`Raw decrypted data: ${rawDecrypted.toString()}`);
        
        // Now try to parse it as a UTXO
        const utxo = await encryptionService.decryptUtxo(encryptedBuffer, lightWasm);
        
        console.log('\nDecrypted UTXO:');
        console.log('- Amount:', utxo.amount.toString());
        console.log('- Blinding:', utxo.blinding.toString());
        console.log('- Index:', utxo.index);
        
        // Generate the commitment for verification
        const commitment = await utxo.getCommitment();
        console.log('- Commitment:', commitment);
        
        // Generate the nullifier
        const nullifier = await utxo.getNullifier();
        console.log('- Nullifier:', nullifier);
      } catch (error: any) {
        console.error('Failed to decrypt as UTXO:', error.message);
        console.log('Trying different decryption methods...');
        
        // Try raw decryption
        try {
          const rawDecrypted = encryptionService.decrypt(encryptedBuffer);
          console.log(`Raw decrypted data: ${rawDecrypted.toString()}`);
          
          // Try to parse the raw data
          if (rawDecrypted.toString().includes('|')) {
            const parts = rawDecrypted.toString().split('|');
            console.log('Parsed pipe-delimited data:');
            console.log('- Part 1 (likely amount):', parts[0]);
            console.log('- Part 2 (likely blinding):', parts[1]);
            console.log('- Part 3 (likely index):', parts[2]);
          }
        } catch (decryptError: any) {
          console.error('Raw decryption also failed:', decryptError.message);
        }
      }
    } catch (error) {
      console.error('Error processing encrypted data:', error);
    }
  } catch (error) {
    console.error('Script error:', error);
  }
}

// Run the function
decryptSpecificUtxo()
  .then(() => console.log('Decryption attempt completed'))
  .catch(err => console.error('Error running script:', err)); 