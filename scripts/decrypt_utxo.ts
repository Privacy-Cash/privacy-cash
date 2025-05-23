import { Keypair, Connection, PublicKey } from '@solana/web3.js';
import { readFileSync } from 'fs';
import * as path from 'path';
import { EncryptionService } from './encryption';

// Program ID for the zkcash program
const PROGRAM_ID = new PublicKey('BByY3XVe36QEn3omkkzZM7rst2mKqt4S4XMCrbM9oUTh');

// Configure connection to Solana devnet
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

/**
 * Decrypts an encrypted UTXO using the wallet's encryption key
 * @param encryptedData The encrypted UTXO data as a hex string or Buffer
 * @returns The decrypted UTXO data
 */
export async function decryptUtxo(encryptedData: string | Buffer): Promise<string> {
  try {
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
      
      // Generate encryption key from the keypair
      encryptionService.generateEncryptionKey(keypair);
      console.log('Encryption key generated from wallet keypair');
    } catch (err) {
      console.error('Could not load deploy-keypair.json from anchor directory', err);
      throw new Error('Failed to load keypair');
    }

    // Convert hex string to Buffer if needed
    const dataBuffer = typeof encryptedData === 'string' 
      ? Buffer.from(encryptedData, 'hex') 
      : encryptedData;
    
    // Decrypt the data
    const decrypted = encryptionService.decrypt(dataBuffer);
    
    // Convert the Buffer to a string
    const decryptedStr = decrypted.toString();
    
    console.log('Successfully decrypted UTXO data');
    
    // Parse the delimited format (amount|blinding|index)
    if (decryptedStr.includes('|')) {
      const [amount, blinding, index] = decryptedStr.split('|');
      console.log('Parsed UTXO data:');
      console.log('- Amount:', amount);
      console.log('- Blinding factor:', blinding);
      console.log('- Index:', index);
    } else {
      // Try parsing as JSON if it's not in pipe-delimited format
      try {
        const jsonData = JSON.parse(decryptedStr);
        console.log('Parsed UTXO data (JSON format):');
        console.log(jsonData);
      } catch (e) {
        // Not JSON either, just return the raw string
        console.log('Raw decrypted data (not in recognized format)');
      }
    }
    
    return decryptedStr;
  } catch (error) {
    console.error('Error decrypting UTXO:', error);
    throw error;
  }
}

/**
 * Fetches and decrypts the UTXO data for a given commitment
 * @param commitment The commitment hash as a hex string
 * @returns The decrypted UTXO data
 */
export async function decryptUtxoFromCommitment(commitment: string): Promise<string> {
  try {
    // Convert the commitment to a Buffer if it's a hex string
    const commitmentBuffer = Buffer.from(commitment.startsWith('0x') ? commitment.slice(2) : commitment, 'hex');
    
    // Find the commitment PDA
    const [commitmentPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("commitment0"), commitmentBuffer],
      PROGRAM_ID
    );
    
    console.log(`Looking up commitment account: ${commitmentPDA.toString()}`);
    
    // Fetch the commitment account data
    const commitmentAccount = await connection.getAccountInfo(commitmentPDA);
    
    if (!commitmentAccount) {
      throw new Error(`Commitment account not found: ${commitmentPDA.toString()}`);
    }
    
    console.log('Commitment account found');
    
    // Parse the account data to extract the encrypted output
    // Format: 8 bytes anchor discriminator + 32 bytes commitment hash + 8 bytes index + 1 byte bump + variable length encrypted output
    // The encrypted output starts at byte offset 49 (8+32+8+1)
    const encryptedOutput = commitmentAccount.data.slice(49);
    
    console.log(`Encrypted output size: ${encryptedOutput.length} bytes`);
    
    // Decrypt the UTXO data
    return await decryptUtxo(encryptedOutput);
  } catch (error) {
    console.error('Error decrypting UTXO from commitment:', error);
    throw error;
  }
}

/**
 * Test function to demonstrate encryption and decryption
 */
export async function testEncryptDecrypt(): Promise<void> {
  try {
    // Initialize the encryption service
    const encryptionService = new EncryptionService();

    // Load wallet keypair
    const anchorDirPath = path.join(__dirname, '..', 'anchor');
    const deployKeypairPath = path.join(anchorDirPath, 'deploy-keypair.json');
    const keypairJson = JSON.parse(readFileSync(deployKeypairPath, 'utf-8'));
    const keypair = Keypair.fromSecretKey(Uint8Array.from(keypairJson));
    
    // Generate encryption key
    encryptionService.generateEncryptionKey(keypair);
    
    // // Create a sample UTXO data
    // const utxoData = '1000000000|123456789|0';
    // console.log('Original UTXO data:', utxoData);
    
    // // Encrypt the UTXO data
    // const encrypted = encryptionService.encrypt(utxoData);
    // console.log('Encrypted size:', encrypted.length, 'bytes');
    // console.log('Encrypted data (hex):', encrypted.toString('hex'));
    
    // Decrypt the UTXO data
    const decrypted = await decryptUtxo("e830bebc9b42cd0a958fff807d9535d88ffee86616f86ce46e0660ec8e6be541676821b917e8ff1d3c876cacd7c7287cbd7584eba6");
    console.log('Decryption result:', decrypted);
    
    console.log('Test completed successfully');
  } catch (error) {
    console.error('Test failed:', error);
  }
}

// Command line interface
if (require.main === module) {
    testEncryptDecrypt()
} 