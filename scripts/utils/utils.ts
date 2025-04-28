/**
 * Utility functions for ZK Cash
 * 
 * Provides common utility functions for the ZK Cash system
 * Based on: https://github.com/tornadocash/tornado-nova
 */

import BN from 'bn.js';

const poseidon = require("circomlib/src/poseidon.js");
export const poseidonHash = (items: any[]) => new BN(poseidon(items).toString())
export const poseidonHash2ToString = (a: any, b: any) => poseidonHash([a, b]).toString();

/**
 * Mock encryption function - in real implementation this would be proper encryption
 * For testing, we just return a fixed prefix to ensure consistent extDataHash
 * @param value Value to encrypt
 * @returns Encrypted string representation
 */
export function mockEncrypt(value: string): string {
  return 'enc_' + value;
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
}): Promise<string> {
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