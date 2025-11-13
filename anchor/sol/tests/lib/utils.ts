import * as anchor from "@coral-xyz/anchor";
import { utils } from "ffjavascript";
import BN from 'bn.js';
import { Utxo } from './utxo';
import * as borsh from 'borsh';
import { sha256 } from '@ethersproject/sha2';
import { PublicKey } from '@solana/web3.js';

/**
 * Converts an anchor.BN to a byte array of length 32 (big-endian format)
 * @param bn - The anchor.BN to convert
 * @returns A number array representing the bytes
 */
export function bnToBytes(bn: anchor.BN): number[] {
  // Cast the result to number[] since we know the output is a byte array
  return Array.from(
    utils.leInt2Buff(utils.unstringifyBigInts(bn.toString()), 32)
  ).reverse() as number[];
}

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
 * @param extData External data object containing recipient, amount, encrypted outputs, fee, fee recipient, and mint address
 * @returns The hash as a Uint8Array (32 bytes)
 */
export function getExtDataHash(extData: {
  recipient: string | PublicKey;
  extAmount: string | number | BN;
  encryptedOutput1?: string | Uint8Array;  // Optional for Account Data Separation
  encryptedOutput2?: string | Uint8Array;  // Optional for Account Data Separation
  fee: string | number | BN;
  feeRecipient: string | PublicKey;
  mintAddress: string | PublicKey;
}): Uint8Array {
  // Convert all inputs to their appropriate types
  const recipient = extData.recipient instanceof PublicKey 
    ? extData.recipient 
    : new PublicKey(extData.recipient);
  
  const feeRecipient = extData.feeRecipient instanceof PublicKey 
    ? extData.feeRecipient 
    : new PublicKey(extData.feeRecipient);
  
  const mintAddress = extData.mintAddress instanceof PublicKey 
    ? extData.mintAddress 
    : new PublicKey(extData.mintAddress);
  
  // Convert to BN for proper i64/u64 handling
  const extAmount = new BN(extData.extAmount.toString());
  const fee = new BN(extData.fee.toString());
  
  // Handle encrypted outputs - they might not be present in Account Data Separation approach
  const encryptedOutput1 = extData.encryptedOutput1 
    ? Buffer.from(extData.encryptedOutput1 as any)
    : Buffer.alloc(0); // Empty buffer if not provided
  const encryptedOutput2 = extData.encryptedOutput2 
    ? Buffer.from(extData.encryptedOutput2 as any)
    : Buffer.alloc(0); // Empty buffer if not provided

  // Define the borsh schema matching the Rust struct
  const schema = {
    struct: {
      recipient: { array: { type: 'u8', len: 32 } },
      extAmount: 'i64',
      encryptedOutput1: { array: { type: 'u8' } },
      encryptedOutput2: { array: { type: 'u8' } },
      fee: 'u64',
      feeRecipient: { array: { type: 'u8', len: 32 } },
      mintAddress: { array: { type: 'u8', len: 32 } },
    }
  };

  const value = {
    recipient: recipient.toBytes(),
    extAmount: extAmount,  // BN instance - Borsh handles it correctly with i64 type
    encryptedOutput1: encryptedOutput1,
    encryptedOutput2: encryptedOutput2,
    fee: fee,  // BN instance - Borsh handles it correctly with u64 type
    feeRecipient: feeRecipient.toBytes(),
    mintAddress: mintAddress.toBytes(),
  };
  
  // Serialize with Borsh
  const serializedData = borsh.serialize(schema, value);
  
  // Calculate the SHA-256 hash
  const hashHex = sha256(serializedData);
  // Convert from hex string to Uint8Array
  return Buffer.from(hashHex.slice(2), 'hex');
} 
