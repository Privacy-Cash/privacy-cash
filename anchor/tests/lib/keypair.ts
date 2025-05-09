/**
 * Keypair module for ZK Cash
 * 
 * Provides cryptographic keypair functionality for the ZK Cash system
 * Based on: https://github.com/tornadocash/tornado-nova
 */

import BN from 'bn.js';
import { ethers } from 'ethers';
import { poseidonHash } from './utils';

// Field size constant
const FIELD_SIZE = new BN(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617'
);

/**
 * Simplified version of Keypair
 */
export class Keypair {
  public privkey: BN;
  public pubkey: BN;

  constructor(privkeyHex: string) {
    const rawDecimal = BigInt(privkeyHex);
    this.privkey = new BN((rawDecimal % BigInt(FIELD_SIZE.toString())).toString());
    // TODO: lazily compute pubkey
    this.pubkey = poseidonHash([this.privkey])
  }

   /**
   * Sign a message using keypair private key
   *
   * @param {string|number|BigNumber} commitment a hex string with commitment
   * @param {string|number|BigNumber} merklePath a hex string with merkle path
   * @returns {BigNumber} a hex string with signature
   */
  sign(commitment: string, merklePath: string): string {
    return poseidonHash([this.privkey, commitment, merklePath]).toString();
  }

  static generateNew(): Keypair {
    // Tornado Cash Nova uses ethers.js to generate a random private key
    // We can't generate Solana keypairs because it won't fit in the field size
    // It's OK to use ethereum secret keys, because the secret key is only used for the proof generation.
    // Namely, it's used to guarantee the uniqueness of the nullifier.
    const wallet = ethers.Wallet.createRandom();
    return new Keypair(wallet.privateKey);
  }
} 