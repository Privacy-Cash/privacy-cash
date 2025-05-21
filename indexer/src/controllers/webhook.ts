import { Context } from 'koa';
import { processNewPDA } from '../services/pda-service';
import { PROGRAM_ID, RPC_ENDPOINT } from '../config';
import { Connection, PublicKey } from '@solana/web3.js';
import { commitmentTreeService } from '../services/commitment-tree-service';

interface HeliusRawTransactionWebhook {
  accountKeys: string[];
  blockTime: number;
  instructions: {
    accounts: string[];
    data: string;
    programId: string;
  }[];
  fee: number;
  signature: string;
  // Additional fields may be present
}

/**
 * Handle Helius webhook payload for raw transaction data
 * Documentation: https://docs.helius.dev/webhooks/webhook-payloads
 */
export async function handleWebhook(ctx: Context): Promise<void> {
  try {
    // Log the full request for debugging and unit test creation
    console.log('--------- WEBHOOK REQUEST START ---------');
    console.log('Headers:', JSON.stringify(ctx.request.headers, null, 2));
    console.log('Body:', JSON.stringify(ctx.request.body, null, 2));
    console.log('--------- WEBHOOK REQUEST END ---------');
    
    const payload = ctx.request.body as HeliusRawTransactionWebhook;
    
    // Check if this is a valid webhook payload
    if (!payload || !payload.signature) {
      console.log('Invalid webhook payload: missing signature');
      ctx.status = 400;
      ctx.body = { success: false, error: 'Invalid webhook payload' };
      return;
    }
    
    console.log(`Received transaction webhook: ${payload.signature}`);
    
    // Check if this transaction involves our program
    const programIndex = payload.accountKeys.findIndex(key => key === PROGRAM_ID.toString());
    if (programIndex === -1) {
      console.log(`Transaction does not involve our program (${PROGRAM_ID.toString()})`);
      // Not our program, respond with success but do nothing
      ctx.status = 200;
      ctx.body = { success: true, message: 'Transaction does not involve our program' };
      return;
    }

    // Look for instructions that call our program
    const ourInstructions = payload.instructions.filter(ix => 
      ix.programId === PROGRAM_ID.toString()
    );
    
    if (ourInstructions.length === 0) {
      console.log(`No instructions found for our program (${PROGRAM_ID.toString()})`);
      ctx.status = 200;
      ctx.body = { success: true, message: 'No instructions for our program' };
      return;
    }

    console.log(`Found ${ourInstructions.length} instructions for our program`);
    console.log('Program instructions:', JSON.stringify(ourInstructions, null, 2));
    
    // Initialize connection to Solana
    const connection = new Connection(RPC_ENDPOINT);
    
    // Process the transaction data to find commitments
    for (const ix of ourInstructions) {
      try {
        // Decode the instruction data (base64 encoded)
        const data = Buffer.from(ix.data, 'base64');
        
        // Check instruction type by examining the first 8 bytes (discriminator)
        // This assumes you're using Anchor which uses 8-byte discriminators
        const discriminator = data.slice(0, 8).toString('hex');
        console.log(`Instruction discriminator: ${discriminator}`);
        
        // Check if this is a 'transact' instruction
        // You'll need to replace this with your actual instruction discriminator for 'transact'
        // For Anchor, you can get this by running: anchor.web3.sha256("global:transact").slice(0, 8)
        const TRANSACT_DISCRIMINATOR = ''; // Fill in your actual discriminator
        
        if (discriminator === TRANSACT_DISCRIMINATOR || true) { // Remove "|| true" once you've filled in the discriminator
          console.log('Found transact instruction');
          console.log('Instruction accounts:', JSON.stringify(ix.accounts, null, 2));
          
          // Extract PDA account from instruction accounts
          // The index depends on your instruction definition
          // This is just an example - adjust based on your program's account structure
          const pdaAccountIndex = 2; // Adjust based on your instruction account structure
          if (ix.accounts.length > pdaAccountIndex) {
            const pdaAccountPubkey = ix.accounts[pdaAccountIndex];
            console.log(`Potential PDA account at index ${pdaAccountIndex}: ${pdaAccountPubkey}`);
            
            // Fetch the PDA account data
            console.log(`Fetching account data for ${pdaAccountPubkey}...`);
            const accountInfo = await connection.getAccountInfo(new PublicKey(pdaAccountPubkey));
            
            if (accountInfo && accountInfo.data) {
              console.log(`Found PDA account: ${pdaAccountPubkey}`);
              console.log(`Account data size: ${accountInfo.data.length} bytes`);
              console.log(`Account owner: ${accountInfo.owner.toString()}`);
              
              // Process the PDA data to extract the commitment
              // This depends on your account structure
              // Example for Anchor-generated PDA with structure defined in README:
              const accountData = accountInfo.data;
              
              // Log first 16 bytes for debugging
              console.log(`Account data first 16 bytes: ${accountData.slice(0, 16).toString('hex')}`);
              
              // Skip 8-byte discriminator
              // Extract 32-byte commitment
              const commitment = accountData.slice(8, 8 + 32);
              const commitmentHex = commitment.toString('hex');
              
              // Extract the index (8 bytes) from the account data
              // Based on the README, index is after discriminator, commitment, and encrypted_output
              // First read the length of encrypted_output
              const encryptedOutputLengthOffset = 8 + 32; // After discriminator and commitment
              const encryptedOutputLength = accountData.readUInt32LE(encryptedOutputLengthOffset);
              console.log(`Encrypted output length: ${encryptedOutputLength}`);
              
              // Index starts after encrypted_output
              const indexOffset = encryptedOutputLengthOffset + 4 + encryptedOutputLength;
              console.log(`Index offset: ${indexOffset}`);
              const indexBuffer = accountData.slice(indexOffset, indexOffset + 8);
              console.log(`Index buffer: ${indexBuffer.toString('hex')}`);
              const index = BigInt(indexBuffer.readBigUInt64LE(0));
              
              console.log(`Extracted commitment: ${commitmentHex} with index: ${index}`);
              
              // Add commitment to Merkle tree with its index
              const addedToTree = commitmentTreeService.addCommitment(commitmentHex, index);
              console.log(`Added to tree: ${addedToTree ? 'success' : 'failed'}`);
              
              // Let the PDA service process it too
              processNewPDA(pdaAccountPubkey, accountData);
              
              console.log(`Added commitment to Merkle tree: ${commitmentHex}`);
            } else {
              console.log(`PDA account ${pdaAccountPubkey} not found or has no data`);
            }
          } else {
            console.log(`Instruction has only ${ix.accounts.length} accounts, not enough to extract PDA at index ${pdaAccountIndex}`);
          }
        } else {
          console.log(`Instruction discriminator ${discriminator} does not match transact discriminator`);
        }
      } catch (err) {
        console.error('Error processing instruction:', err);
      }
    }
    
    // Respond with success
    ctx.status = 200;
    ctx.body = { success: true };
  } catch (error) {
    console.error('Error handling webhook:', error);
    ctx.status = 500;
    ctx.body = { success: false, error: 'Internal server error' };
  }
} 