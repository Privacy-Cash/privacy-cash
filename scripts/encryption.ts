import { Keypair } from '@solana/web3.js';
import * as nacl from 'tweetnacl';
import * as bs58 from 'bs58';
import * as crypto from 'crypto';

/**
 * Service for handling encryption and decryption of UTXO data
 */
export class EncryptionService {
  private encryptionKey: Uint8Array | null = null;
  private static readonly MESSAGE_TO_SIGN = 'ZKCash Account Generation';
  
  /**
   * Generate a deterministic encryption key from a Solana keypair
   * @param keypair The Solana keypair to use for signing
   * @returns The generated encryption key
   */
  public generateEncryptionKey(keypair: Keypair): Uint8Array {
    // Sign the constant message with the keypair
    const message = Buffer.from(EncryptionService.MESSAGE_TO_SIGN);
    const signature = nacl.sign.detached(message, keypair.secretKey);
    
    // Extract the first 31 bytes of the signature to create a deterministic key
    const encryptionKey = signature.slice(0, 31);
    
    // Store the key in the service
    this.encryptionKey = encryptionKey;
    
    return encryptionKey;
  }
  
  /**
   * Generates a deterministic keypair for UTXO operations from the encryption key
   * @param salt Optional salt value to generate different keypairs from the same encryption key
   * @returns A deterministic keypair derived from the encryption key
   * @throws Error if the encryption key has not been generated
   */
  public getUtxoKeypair(salt: string = ''): { pubkey: string; privkey: string } {
    if (!this.encryptionKey) {
      throw new Error('Encryption key not generated. Call generateEncryptionKey first.');
    }
    
    // Create a seed by combining the encryption key with an optional salt
    const seedData = Buffer.concat([
      Buffer.from(this.encryptionKey),
      Buffer.from(salt)
    ]);
    
    // Use a hash function to generate a deterministic seed
    const hashedSeed = crypto.createHash('sha256').update(seedData).digest();
    
    // Use tweetnacl to generate a keypair from the seed
    const keypair = nacl.sign.keyPair.fromSeed(hashedSeed.slice(0, 32));
    
    // Return the keypair in the format expected by the UTXO model
    return {
      pubkey: Buffer.from(keypair.publicKey).toString('hex'),
      privkey: Buffer.from(keypair.secretKey.slice(0, 32)).toString('hex')
    };
  }
  
  /**
   * Generates a deterministic private key for UTXO operations from the encryption key
   * This key will be used to create a Keypair object for UTXOs
   * @param salt Optional salt value to generate different private keys from the same encryption key
   * @returns A private key in hex format that can be used to create a Keypair
   * @throws Error if the encryption key has not been generated
   */
  public getUtxoPrivateKey(salt: string = ''): string {
    if (!this.encryptionKey) {
      throw new Error('Encryption key not generated. Call generateEncryptionKey first.');
    }
    
    // Create a seed by combining the encryption key with an optional salt
    const seedData = Buffer.concat([
      Buffer.from(this.encryptionKey),
      Buffer.from(salt)
    ]);
    
    // Use a hash function to generate a deterministic seed
    const hashedSeed = crypto.createHash('sha256').update(seedData).digest();
    
    // Convert to a hex string (needed for the Keypair constructor)
    // The format needs to be compatible with ethers.js private key
    return '0x' + hashedSeed.toString('hex');
  }
  
  /**
   * Encrypt data with the stored encryption key
   * @param data The data to encrypt
   * @returns The encrypted data as a Buffer
   * @throws Error if the encryption key has not been generated
   */
  public encrypt(data: Buffer | string): Buffer {
    if (!this.encryptionKey) {
      throw new Error('Encryption key not generated. Call generateEncryptionKey first.');
    }
    
    // Convert string to Buffer if needed
    const dataBuffer = typeof data === 'string' ? Buffer.from(data) : data;
    
    // Generate a standard initialization vector (16 bytes)
    const iv = crypto.randomBytes(16);
    
    // Create a key from our encryption key (using only first 16 bytes for AES-128)
    const key = Buffer.from(this.encryptionKey).slice(0, 16);
    
    // Use a more compact encryption algorithm (aes-128-ctr)
    const cipher = crypto.createCipheriv('aes-128-ctr', key, iv);
    const encryptedData = Buffer.concat([
      cipher.update(dataBuffer),
      cipher.final()
    ]);
    
    // Create an authentication tag (HMAC) to verify decryption with correct key
    const hmacKey = Buffer.from(this.encryptionKey).slice(16, 31);
    const hmac = crypto.createHmac('sha256', hmacKey);
    hmac.update(iv);
    hmac.update(encryptedData);
    const authTag = hmac.digest().slice(0, 16); // Use first 16 bytes of HMAC as auth tag
    
    // Combine IV, auth tag and encrypted data
    return Buffer.concat([iv, authTag, encryptedData]);
  }
  
  /**
   * Decrypt data with the stored encryption key
   * @param encryptedData The encrypted data to decrypt
   * @returns The decrypted data as a Buffer
   * @throws Error if the encryption key has not been generated or if the wrong key is used
   */
  public decrypt(encryptedData: Buffer): Buffer {
    if (!this.encryptionKey) {
      throw new Error('Encryption key not generated. Call generateEncryptionKey first.');
    }
    
    // Extract the IV from the first 16 bytes
    const iv = encryptedData.slice(0, 16);
    // Extract the auth tag from the next 16 bytes
    const authTag = encryptedData.slice(16, 32);
    // The rest is the actual encrypted data
    const data = encryptedData.slice(32);
    
    // Verify the authentication tag
    const hmacKey = Buffer.from(this.encryptionKey).slice(16, 31);
    const hmac = crypto.createHmac('sha256', hmacKey);
    hmac.update(iv);
    hmac.update(data);
    const calculatedTag = hmac.digest().slice(0, 16);
    
    // Compare tags - if they don't match, the key is wrong
    if (!crypto.timingSafeEqual(authTag, calculatedTag)) {
      throw new Error('Failed to decrypt data. Invalid encryption key or corrupted data.');
    }
    
    // Create a key from our encryption key (using only first 16 bytes for AES-128)
    const key = Buffer.from(this.encryptionKey).slice(0, 16);
    
    // Use the same algorithm as in encrypt
    const decipher = crypto.createDecipheriv('aes-128-ctr', key, iv);
    
    try {
      return Buffer.concat([
        decipher.update(data),
        decipher.final()
      ]);
    } catch (error) {
      throw new Error('Failed to decrypt data. Invalid encryption key or corrupted data.');
    }
  }
  
  /**
   * Check if the encryption key has been generated
   * @returns True if the encryption key exists, false otherwise
   */
  public hasEncryptionKey(): boolean {
    return this.encryptionKey !== null;
  }
  
  /**
   * Get the encryption key (for testing purposes)
   * @returns The current encryption key or null
   */
  public getEncryptionKey(): Uint8Array | null {
    return this.encryptionKey;
  }
  
  /**
   * Reset the encryption key (mainly for testing purposes)
   */
  public resetEncryptionKey(): void {
    this.encryptionKey = null;
  }
} 