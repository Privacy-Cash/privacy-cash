import { AccountInfo, PublicKey } from '@solana/web3.js';
import { PROGRAM_ID, connection } from '../config';

// In-memory storage for PDAs (in production, use a database)
let pdaIdList: string[] = [];

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
    // Query all accounts owned by your program
    const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
      filters: [
        // Filter for commitment accounts
        // You may need to adjust this based on your account discriminator or data structure
        // { dataSize: 41 }, // Example: Minimum size for a commitment account (adjust as needed)
      ],
    });
    
    console.log(`Found ${accounts.length} program accounts`);
    
    // Process each account to extract IDs
    const ids: string[] = [];
    
    for (const { pubkey, account } of accounts) {
      // Check if this is a commitment account by looking at account data structure
      // This may require filtering by account discriminator if you have multiple account types
      const parsedAccount = parseCommitmentAccount(account);
      
      if (parsedAccount) {
        const id = getCommitmentId(parsedAccount);
        ids.push(id);
        console.log(`Added commitment ID: ${id} (index: ${parsedAccount.index})`);
      }
    }
    
    // Store the IDs in memory
    pdaIdList = ids;
    console.log(`Loaded ${pdaIdList.length} commitment IDs`);
    
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