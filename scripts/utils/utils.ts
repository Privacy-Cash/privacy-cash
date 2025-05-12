/**
 * Utility functions for ZK Cash
 * 
 * Provides common utility functions for the ZK Cash system
 * Based on: https://github.com/tornadocash/tornado-nova
 */

import BN from 'bn.js';
import { Utxo } from '../models/utxo';
import * as borsh from 'borsh';
import { sha256 } from '@ethersproject/sha2';
import { PublicKey } from '@solana/web3.js';
/**
 * Mock encryption function - in real implementation this would be proper encryption
 * For testing, we just return a fixed prefix to ensure consistent extDataHash
 * @param value Value to encrypt
 * @returns Encrypted string representation
 */
export function mockEncrypt(value: Utxo): string {
  return JSON.stringify(value);
}

/**
 * Calculates the hash of ext data using Borsh serialization
 * @param extData External data object containing recipient, amount, and encrypted outputs
 * @returns The hash as a Uint8Array (32 bytes)
 */
export function getExtDataHash(extData: {
  recipient: string | PublicKey;
  extAmount: string | number | BN;
  encryptedOutput1: string | Uint8Array;
  encryptedOutput2: string | Uint8Array;
  fee: string | number | BN;
  tokenMint: string | PublicKey;
}): Uint8Array {
  // Convert all inputs to their appropriate types
  const recipient = extData.recipient instanceof PublicKey 
    ? extData.recipient 
    : new PublicKey(extData.recipient);
  
  // Convert to BN for proper i64/u64 handling
  const extAmount = new BN(extData.extAmount.toString());
  const fee = new BN(extData.fee.toString());
  
  // Always convert to Buffer
  const encryptedOutput1 = Buffer.from(extData.encryptedOutput1 as any);
  const encryptedOutput2 = Buffer.from(extData.encryptedOutput2 as any);
  
  const tokenMint = extData.tokenMint instanceof PublicKey 
    ? extData.tokenMint 
    : new PublicKey(extData.tokenMint);

  // Define the borsh schema matching the Rust struct
  const schema = {
    struct: {
      recipient: { array: { type: 'u8', len: 32 } },
      extAmount: 'i64',
      encryptedOutput1: { array: { type: 'u8' } },
      encryptedOutput2: { array: { type: 'u8' } },
      fee: 'u64',
      tokenMint: { array: { type: 'u8', len: 32 } },
    }
  };

  const value = {
    recipient: recipient.toBytes(),
    extAmount: extAmount,  // BN instance - Borsh handles it correctly with i64 type
    encryptedOutput1: encryptedOutput1,
    encryptedOutput2: encryptedOutput2,
    fee: fee,  // BN instance - Borsh handles it correctly with u64 type
    tokenMint: tokenMint.toBytes(),
  };
  
  // Serialize with Borsh
  const serializedData = borsh.serialize(schema, value);
  
  // Calculate the SHA-256 hash
  const hashHex = sha256(serializedData);
  // Convert from hex string to Uint8Array
  return Buffer.from(hashHex.slice(2), 'hex');
} 