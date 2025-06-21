/**
 * UTXO (Unspent Transaction Output) module for ZK Cash
 * 
 * Provides UTXO functionality for the ZK Cash system
 * Based on: https://github.com/tornadocash/tornado-nova
 */

import BN from 'bn.js';
import { Keypair } from './keypair';
import { LightWasm } from '@lightprotocol/hasher.rs';
import { ethers } from 'ethers';

/**
 * Simplified Utxo class inspired by Tornado Cash Nova
 * Based on: https://github.com/tornadocash/tornado-nova/blob/f9264eeffe48bf5e04e19d8086ee6ec58cdf0d9e/src/utxo.js
 */
export class Utxo {
  amount: BN;
  blinding: BN;
  keypair: Keypair;
  index: number;
  mintAddress: string;
  private lightWasm: LightWasm;

  constructor({ 
    lightWasm,
    amount = new BN(0), 
    /**
     * Tornado nova doesn't use solana eddsa with curve 25519 but their own "keypair"
     * which is:
     * - private key: random [31;u8]
     * - public key: PoseidonHash(privateKey)
     * 
     * Generate a new keypair for each UTXO
     */
    keypair, 
    blinding = new BN(Math.floor(Math.random() * 1000000000)), // Use fixed value for consistency instead of randomBN()
    index = 0,
    mintAddress = '11111111111111111111111111111112' // Default to Solana native SOL mint address
  }: { 
    lightWasm: LightWasm,
    amount?: BN | number | string, 
    keypair?: Keypair, 
    blinding?: BN | number | string, 
    index?: number,
    mintAddress?: string
  }) {
    this.amount = new BN(amount.toString());
    this.blinding = new BN(blinding.toString());
    this.lightWasm = lightWasm;
    this.keypair = keypair || new Keypair(ethers.Wallet.createRandom().privateKey, lightWasm);
    this.index = index;
    this.mintAddress = mintAddress;
  }

  async getCommitment(): Promise<string> {
    return this.lightWasm.poseidonHashString([this.amount.toString(), this.keypair.pubkey.toString(), this.blinding.toString(), this.mintAddress]);
  }

  async getNullifier(): Promise<string> {
    const commitmentValue = await this.getCommitment();
    const signature = this.keypair.sign(commitmentValue, new BN(this.index).toString());
    
    return this.lightWasm.poseidonHashString([commitmentValue, new BN(this.index).toString(), signature]);
  }
  
  /**
   * Log all the UTXO's public properties and derived values in JSON format
   * @returns Promise that resolves once all logging is complete
   */
  async log(): Promise<void> {
    // Prepare the UTXO data object
    const utxoData: any = {
      amount: this.amount.toString(),
      blinding: this.blinding.toString(),
      index: this.index,
      mintAddress: this.mintAddress,
      keypair: {
        pubkey: this.keypair.pubkey.toString()
      }
    };
    
    // Add derived values
    try {
      utxoData.commitment = await this.getCommitment();
      utxoData.nullifier = await this.getNullifier();
    } catch (error: any) {
      utxoData.error = error.message;
    }
    
    // Output as formatted JSON
    console.log(JSON.stringify(utxoData, null, 2));
  }
} 