/**
 * Utility functions for ZK Cash
 * 
 * Provides common utility functions for the ZK Cash system
 * Based on: https://github.com/tornadocash/tornado-nova
 */

import BN from 'bn.js';
import { Utxo } from '../models/utxo';
import { keccak256 } from '@ethersproject/keccak256';

const poseidon = require("circomlib/src/poseidon.js");
export const poseidonHash = (items: any[]) => new BN(poseidon(items).toString())
export const poseidonHash2ToString = (a: any, b: any) => poseidonHash([a, b]).toString();

/**
 * Mock encryption function - in real implementation this would be proper encryption
 * For testing, we just return a fixed prefix to ensure consistent extDataHash
 * @param value Value to encrypt
 * @returns Encrypted string representation
 */
export function mockEncrypt(value: Utxo): string {
  return JSON.stringify(value);
}

export function toFixedHex(number: any, length = 32) {
  let result =
    '0x' +
    (number instanceof Buffer
      ? number.toString('hex')
      : new BN(number).toString(16).replace('0x', '')
    ).padStart(length * 2, '0')
  if (result.indexOf('-') > -1) {
    result = '-' + result.replace('-', '')
  }
  return result
}

/**
 * Calculates the Poseidon hash of ext data
 * @param extData External data object containing recipient, amount, and encrypted outputs
 * @returns Promise resolving to the hash as a string
 */
export async function getExtDataHash(extData: {
  recipient: string;
  extAmount: string | number;
  encryptedOutput1: string;
  encryptedOutput2: string;
  fee: string | number;
  tokenMint: string;
}): Promise<string> {
  // Prepare inputs as array of field elements
  const inputs = [
    // For hex addresses, remove 0x prefix and convert from hex to decimal
    new BN(extData.recipient.toString().replace('0x', ''), 16),
    // For numeric values, parse directly
    new BN(extData.extAmount.toString()),
    // For encrypted outputs, use a deterministic numeric representation
    new BN(extData.encryptedOutput1.toString().split('').map((c: string) => c.charCodeAt(0).toString(16)).join(''), 16),
    new BN(extData.encryptedOutput2.toString().split('').map((c: string) => c.charCodeAt(0).toString(16)).join(''), 16),
    new BN(extData.fee.toString()),
    new BN(extData.tokenMint.toString().replace('0x', ''), 16)
  ];
  
  // Convert to a single string and then to bytes
  const inputStr = inputs.map(bn => bn.toString()).join('');
  
  // Log the inputs for debugging
  console.log('Keccak inputs:', inputStr);
  
  // Calculate the keccak256 hash
  const hash = keccak256(Buffer.from(inputStr, 'utf8'));
  
  // Remove '0x' prefix and return
  return new BN(hash.slice(2), 16).toString(10);
} 