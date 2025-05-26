import { AccountInfo, PublicKey } from '@solana/web3.js';
import { PROGRAM_ID, connection } from '../config';
import * as crypto from 'crypto';
import bs58 from 'bs58';
import { commitmentTreeService } from './commitment-tree-service';
import { userUxtosService } from './user-uxtos-service';

// Default tree height - must match the value in commitment-tree-service.ts
const DEFAULT_TREE_HEIGHT = 20;

// In-memory storage for PDAs (in production, use a database)
let pdaIdList: string[] = [];

// Get the account discriminator for a given account type
function getAccountDiscriminator(accountName: string): Buffer {
  // In Anchor, the discriminator is the first 8 bytes of the SHA256 hash of the account name
  return Buffer.from(
    crypto.createHash('sha256')
      .update(`account:${accountName}`)
      .digest()
      .slice(0, 8)
  );
}

// The discriminator for CommitmentAccount
const COMMITMENT_DISCRIMINATOR = getAccountDiscriminator('CommitmentAccount');

// Commitment account layout (based on your Anchor program)
interface CommitmentAccount {
  commitment: Uint8Array;
  encrypted_output: Uint8Array;
  index: bigint;
  bump: number;
}

/**
 * Parse account data into a CommitmentAccount structure
 */
function parseCommitmentAccount(accountInfo: AccountInfo<Buffer>): CommitmentAccount | null {
  try {
    // Check if account data is large enough
    if (accountInfo.data.length < 8) {
      return null;
    }

    // Check if this is a CommitmentAccount by comparing the discriminator
    const discriminator = accountInfo.data.slice(0, 8);
    if (!discriminator.equals(COMMITMENT_DISCRIMINATOR)) {
      console.log(`Account ${accountInfo.owner} is not a valid commitment account`);
      return null;
    }

    // Skip discriminator (8 bytes)
    const dataView = new DataView(accountInfo.data.buffer, accountInfo.data.byteOffset + 8);

    // Read commitment (32 bytes)
    const commitment = new Uint8Array(accountInfo.data.slice(8, 8 + 32));
    
    // Next comes the encrypted_output vector which has a length prefix
    let offset = 8 + 32;
    const encryptedOutputLength = accountInfo.data.readUInt32LE(offset);
    offset += 4;
    const encrypted_output = new Uint8Array(accountInfo.data.slice(offset, offset + encryptedOutputLength));
    offset += encryptedOutputLength;
    
    // Read index (8 bytes)
    const index = BigInt(dataView.getBigUint64(offset - 8, true));
    offset += 8;
    
    // Read bump (1 byte)
    const bump = accountInfo.data[offset];
    
    return { commitment, encrypted_output, index, bump };
  } catch (error) {
    console.error('Error parsing commitment account:', error);
    return null;
  }
}

/**
 * Extract the commitment ID from a parsed account
 */
function getCommitmentId(account: CommitmentAccount): string {
  // Convert the commitment to a string (base64 or hex, depending on your needs)
  return Buffer.from(account.commitment).toString('hex');
}

/**
 * Load all historical PDAs from the Solana blockchain
 */
export async function loadHistoricalPDAs(): Promise<string[]> {
  console.log('Loading historical PDA data...');
  
  try {
    // Initialize the commitment tree service first
    await commitmentTreeService.initialize();
    
    // Initialize the user UXTOs service
    userUxtosService.initialize();
    
    // Query all accounts owned by your program
    const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
      filters: [
        // Filter for commitment accounts using the account discriminator
        {
          memcmp: {
            offset: 0, // Discriminator is at the beginning of the account data
            bytes: bs58.encode(COMMITMENT_DISCRIMINATOR)
          }
        }
      ],
    });
    
    console.log(`Found ${accounts.length} program accounts`);
    
    // Process each account to extract IDs
    const ids: string[] = [];
    const commitments: Array<{hash: string, index: bigint}> = [];
    
    for (const { pubkey, account } of accounts) {
      console.log(`Processing account ${pubkey} with data size ${account.data.length} bytes`);
      const parsedAccount = parseCommitmentAccount(account);
      
      if (parsedAccount) {
        const id = getCommitmentId(parsedAccount);
        ids.push(id);
        console.log(`Added commitment ID: ${id} (index: ${parsedAccount.index})`);
        
        // Add to the commitments array for bulk insertion into the tree
        commitments.push({
          hash: id,
          index: parsedAccount.index
        });
        
        // Add the encrypted output to the user UXTOs service
        userUxtosService.addEncryptedOutput(parsedAccount.encrypted_output);
      } else {
        console.log(`Account ${pubkey} is not a valid commitment account`);
      }
    }
    
    // Store the IDs in memory
    pdaIdList = ids;
    console.log(`Loaded ${pdaIdList.length} commitment IDs`);
    
    // Add all commitments to the tree at once
    if (commitments.length > 0) {
      const addedCount = commitmentTreeService.addCommitments(commitments);
      console.log(`Added ${addedCount} commitments to the Merkle tree`);
      console.log(`Current Merkle tree root: ${commitmentTreeService.getRoot()}`);
    }
    
    console.log(`Total encrypted outputs in hashset: ${userUxtosService.getEncryptedOutputCount()}`);
    
    return ids;
  } catch (error) {
    console.error('Error loading historical PDAs:', error);
    throw error;
  }
}

/**
 * Process a new PDA account update from a webhook or other source
 */
export function processNewPDA(accountPubkey: string, accountData: Buffer): void {
  try {
    // Create an AccountInfo-like object from the webhook data
    const accountInfo: AccountInfo<Buffer> = {
      data: accountData,
      executable: false,
      lamports: 0, // This might not be available from webhook
      owner: PROGRAM_ID,
      rentEpoch: 0, // This might not be available from webhook
    };
    
    const parsedAccount = parseCommitmentAccount(accountInfo);
    
    if (parsedAccount) {
      const id = getCommitmentId(parsedAccount);
      
      // Add to our in-memory list if not already present
      if (!pdaIdList.includes(id)) {
        pdaIdList.push(id);
        console.log(`Added new commitment ID: ${id} (index: ${parsedAccount.index})`);
        
        // Add the commitment to the Merkle tree
        const added = commitmentTreeService.addCommitment(id, parsedAccount.index);
        if (added) {
          console.log(`Added commitment to the tree at index ${parsedAccount.index}`);
        } else {
          console.log(`Failed to add commitment at index ${parsedAccount.index}`);
        }
        
        // Add the encrypted output to the user UXTOs service
        userUxtosService.addEncryptedOutput(parsedAccount.encrypted_output);
      }
    }
  } catch (error) {
    console.error('Error processing new PDA:', error);
  }
}

/**
 * Get the current list of all commitment IDs
 */
export function getAllCommitmentIds(): string[] {
  return pdaIdList;
}

/**
 * Get a Merkle proof for a commitment
 * @param commitmentId The commitment ID (hash)
 * @returns The Merkle proof or null if not found
 */
export function getMerkleProof(commitmentId: string): {pathElements: string[], pathIndices: number[]} | null {
  try {
    // Get all commitments from the tree
    const commitments = commitmentTreeService.getAllCommitments();
    
    // Find the index of the commitment
    const index = commitments.indexOf(commitmentId);
    if (index === -1) {
      return null;
    }
    
    // Get the proof from the tree
    return commitmentTreeService.getMerkleProof(index);
  } catch (error) {
    console.error('Error getting Merkle proof:', error);
    return null;
  }
}

/**
 * Get the current Merkle tree root
 */
export function getMerkleRoot(): string {
  try {
    return commitmentTreeService.getRoot();
  } catch (error) {
    console.error('Error getting Merkle root:', error);
    return '';
  }
}

/**
 * Check if an encrypted output exists
 * @param encryptedOutput The encrypted output to check
 * @returns true if the encrypted output exists, false otherwise
 */
export function hasEncryptedOutput(encryptedOutput: Uint8Array | string): boolean {
  try {
    return userUxtosService.hasEncryptedOutput(encryptedOutput);
  } catch (error) {
    console.error('Error checking encrypted output:', error);
    return false;
  }
}

/**
 * Get all encrypted outputs
 * @returns Array of encrypted outputs
 */
export function getAllEncryptedOutputs(): string[] {
  try {
    return userUxtosService.getAllEncryptedOutputs();
  } catch (error) {
    console.error('Error getting all encrypted outputs:', error);
    return [];
  }
}

/**
 * Get a Merkle proof for a specific index in the tree
 * @param index The index in the Merkle tree
 * @returns The Merkle path elements or null if the index is invalid
 */
export function getMerkleProofByIndex(index: number): string[] | null {
  try {
    // Get all commitments from the tree
    const commitments = commitmentTreeService.getAllCommitments();
    
    // Check if the index is valid
    if (index < 0 || index >= commitments.length) {
      console.error(`Invalid index ${index}, tree has ${commitments.length} elements`);
      
      // Return dummy Merkle proof with zeros instead of null
      return [...new Array(DEFAULT_TREE_HEIGHT).fill("0")];
    }
    
    // Get the proof from the tree
    const proof = commitmentTreeService.getMerkleProof(index);
    
    // Return only the path elements
    return proof.pathElements;
  } catch (error) {
    console.error('Error getting Merkle proof by index:', error);
    
    // Return dummy Merkle proof with zeros instead of null in case of error
    return [...new Array(DEFAULT_TREE_HEIGHT).fill("0")];
  }
} 