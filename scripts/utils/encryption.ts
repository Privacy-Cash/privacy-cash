import { Keypair } from '@solana/web3.js';
import * as nacl from 'tweetnacl';
import * as bs58 from 'bs58';
import * as crypto from 'crypto';
import { Utxo } from '../models/utxo';
import { WasmFactory } from '@lightprotocol/hasher.rs';
import { BN } from 'bn.js';
import { Keypair as UtxoKeypair } from '../models/keypair';
import { ethers } from 'ethers';

/**
 * Represents a UTXO with minimal required fields
 */
export interface UtxoData {
  amount: string;
  blinding: string;
  index: number | string;
  // Optional additional fields
  [key: string]: any;
}

/**
 * Service for handling encryption and decryption of UTXO data
 */
export class EncryptionService {
  private encryptionKey: Uint8Array | null = null;
  
  /**
   * Initialize the encryption service with an encryption key
   * @param encryptionKey The encryption key to use for encryption and decryption
   */
  constructor(encryptionKey?: Uint8Array) {
    if (encryptionKey) {
      this.encryptionKey = encryptionKey;
    }
  }
  
  /**
   * Set the encryption key directly
   * @param encryptionKey The encryption key to set
   */
  public setEncryptionKey(encryptionKey: Uint8Array): void {
    this.encryptionKey = encryptionKey;
  }
  
  /**
   * Generate an encryption key from a wallet keypair
   * @param keypair The Solana keypair to derive the encryption key from
   * @returns The generated encryption key
   */
  public deriveEncryptionKeyFromWallet(keypair: Keypair): Uint8Array {
    // Sign a constant message with the keypair
    const message = Buffer.from('Privacy Money account sign in');
    const signature = nacl.sign.detached(message, keypair.secretKey);
    
    // Extract the first 31 bytes of the signature to create a deterministic key
    const encryptionKey = signature.slice(0, 31);
    
    // Store the key in the service
    this.encryptionKey = encryptionKey;
    
    return encryptionKey;
  }
  
  /**
   * Encrypt data with the stored encryption key
   * @param data The data to encrypt
   * @returns The encrypted data as a Buffer
   * @throws Error if the encryption key has not been generated
   */
  public encrypt(data: Buffer | string): Buffer {
    if (!this.encryptionKey) {
      throw new Error('Encryption key not set. Call setEncryptionKey or deriveEncryptionKeyFromWallet first.');
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
      throw new Error('Encryption key not set. Call setEncryptionKey or deriveEncryptionKeyFromWallet first.');
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
   * Check if the encryption key has been set
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
  
  /**
   * Encrypt a UTXO using a compact pipe-delimited format
   * @param utxo The UTXO to encrypt
   * @returns The encrypted UTXO data as a Buffer
   * @throws Error if the encryption key has not been set
   */
  public encryptUtxo(utxo: Utxo): Buffer {
    if (!this.encryptionKey) {
      throw new Error('Encryption key not set. Call setEncryptionKey or deriveEncryptionKeyFromWallet first.');
    }
    
    // Create a compact string representation using pipe delimiter
    const utxoString = `${utxo.amount.toString()}|${utxo.blinding.toString()}|${utxo.index}|${utxo.mintAddress}`;
    
    // Use the regular encrypt method
    return this.encrypt(utxoString);
  }
  
  /**
   * Decrypt an encrypted UTXO and parse it to a Utxo instance
   * @param encryptedData The encrypted UTXO data
   * @param keypair The UTXO keypair to use for the decrypted UTXO
   * @param lightWasm Optional LightWasm instance. If not provided, a new one will be created
   * @returns Promise resolving to the decrypted Utxo instance
   * @throws Error if the encryption key has not been set or if decryption fails
   */
  public async decryptUtxo(encryptedData: Buffer | string, keypair: UtxoKeypair, lightWasm?: any): Promise<Utxo> {
    if (!this.encryptionKey) {
      throw new Error('Encryption key not set. Call setEncryptionKey or deriveEncryptionKeyFromWallet first.');
    }
    
    // Convert hex string to Buffer if needed
    const encryptedBuffer = typeof encryptedData === 'string' 
      ? Buffer.from(encryptedData, 'hex')
      : encryptedData;
    
    // Decrypt the data using the regular decrypt method
    const decrypted = this.decrypt(encryptedBuffer);
    
    // Parse the pipe-delimited format
    const decryptedStr = decrypted.toString();
    const [amount, blinding, index, mintAddress] = decryptedStr.split('|');
    
    if (!amount || !blinding || index === undefined || mintAddress === undefined) {
      throw new Error('Invalid UTXO format after decryption');
    }
    
    // Get or create a LightWasm instance
    const wasmInstance = lightWasm || await WasmFactory.getInstance();
    
    // Create a Utxo instance with the provided keypair
    return new Utxo({
      lightWasm: wasmInstance,
      amount: amount,
      blinding: blinding,
      keypair: keypair,
      index: Number(index),
      mintAddress: mintAddress
    });
  }
  
  /**
   * Derive a deterministic UTXO private key from the wallet's encryption key
   * @returns A private key in hex format that can be used to create a UTXO keypair
   * @throws Error if the encryption key has not been set
   */
  public deriveUtxoPrivateKey(): string {
    if (!this.encryptionKey) {
      throw new Error('Encryption key not set. Call setEncryptionKey or deriveEncryptionKeyFromWallet first.');
    }
    
    // Use a hash function to generate a deterministic private key from the encryption key
    const hashedSeed = crypto.createHash('sha256').update(this.encryptionKey).digest();
    
    // Convert to a hex string compatible with ethers.js private key format
    return '0x' + hashedSeed.toString('hex');
  }
} 