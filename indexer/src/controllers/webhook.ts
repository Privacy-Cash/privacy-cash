import { Context } from 'koa';
import { processNewPDA } from '../services/pda-service';
import { PROGRAM_ID, RPC_ENDPOINT } from '../config';
import { Connection, PublicKey } from '@solana/web3.js';
import { commitmentTreeService } from '../services/commitment-tree-service';

// Updated interface to match the actual Helius webhook payload format
interface HeliusWebhookPayload {
  signature: string;
  accountData?: Array<{
    account: string;
    nativeBalanceChange: number;
    tokenBalanceChanges: any[];
  }>;
  instructions?: Array<{
    accounts: string[];
    data: string;
    programId: string;
    innerInstructions?: any[];
  }>;
  // Other fields might be present
}

/**
 * Handle Helius webhook payload
 * Documentation: https://docs.helius.dev/webhooks/webhook-payloads
 */
export async function handleWebhook(ctx: Context): Promise<void> {
  try {
    // Log the full request for debugging and unit test creation
    console.log('--------- WEBHOOK REQUEST START ---------');
    console.log('Headers:', JSON.stringify(ctx.request.headers, null, 2));
    console.log('Body:', JSON.stringify(ctx.request.body, null, 2));
    console.log('--------- WEBHOOK REQUEST END ---------');
    
    const payload = ctx.request.body;
    
    // Check if this is a valid webhook payload (an array from Helius)
    if (!Array.isArray(payload)) {
      console.log('deposit request invalid', {
        headers: ctx.request.headers,
        header: ctx.request.headers.authorization
      });
      ctx.status = 400;
      ctx.body = { success: false, error: 'Invalid webhook payload format - expected array' };
      return;
    }
    
    console.log(`Received webhook with ${payload.length} transactions`);
    
    // Initialize connection to Solana
    const connection = new Connection(RPC_ENDPOINT);
    
    // Process each transaction in the payload
    for (const transaction of payload) {
      try {
        const signature = transaction.signature;
        console.log(`Processing transaction: ${signature}`);
        
        // Look for instructions that call our program
        if (transaction.instructions) {
          const programInstructions = transaction.instructions.filter(
            (ix: { programId: string }) => ix.programId === PROGRAM_ID.toString()
          );
          
          if (programInstructions.length > 0) {
            console.log(`Found ${programInstructions.length} instructions for our program in transaction ${signature}`);
            
            // Process each instruction that calls our program
            for (const instruction of programInstructions) {
              console.log(`Processing instruction with ${instruction.accounts.length} accounts`);
              
              // For Anchor-based programs, we need to examine the instruction data
              // to determine the instruction type (like "transact")
              const data = Buffer.from(instruction.data, 'base64');
              
              // Check if this is a long enough data payload to extract discriminator
              if (data.length >= 8) {
                // Extract the instruction discriminator (first 8 bytes)
                const discriminator = data.slice(0, 8).toString('hex');
                console.log(`Instruction discriminator: ${discriminator}`);
                
                // Here, you'd ideally check if this matches your "transact" discriminator
                // For now, we'll process any instruction from your program
                
                // Find the PDA accounts in the instruction
                // In Anchor, PDAs are typically passed as accounts to the instruction
                // For a transact instruction, it might be one of the accounts in the list
                // You'll need to adjust this based on your program's account structure
                
                // Look at positions that might contain PDAs (adjust these indices based on your program)
                const potentialPDAIndices = [2, 3, 4]; // Example indices where PDAs might be
                
                for (const index of potentialPDAIndices) {
                  if (instruction.accounts.length > index) {
                    const potentialPDA = instruction.accounts[index];
                    console.log(`Checking potential PDA at index ${index}: ${potentialPDA}`);
                    
                    try {
                      // Fetch the account data
                      const accountInfo = await connection.getAccountInfo(new PublicKey(potentialPDA));
                      
                      if (!accountInfo || !accountInfo.data) {
                        console.log(`No data found for account ${potentialPDA}`);
                        continue;
                      }
                      
                      // Check if the account is owned by our program
                      if (!accountInfo.owner.equals(PROGRAM_ID)) {
                        console.log(`Account ${potentialPDA} not owned by our program`);
                        continue;
                      }
                      
                      console.log(`Found PDA owned by our program: ${potentialPDA}`);
                      console.log(`Account data size: ${accountInfo.data.length} bytes`);
                      
                      // Check if data is long enough to be a commitment account
                      if (accountInfo.data.length < 8 + 32) {
                        console.log(`Account data too small for a commitment account: ${accountInfo.data.length} bytes`);
                        continue;
                      }
                      
                      // Process the account data
                      const data = accountInfo.data;
                      
                      // Skip 8-byte discriminator
                      // Extract 32-byte commitment
                      const commitment = data.slice(8, 8 + 32);
                      const commitmentHex = commitment.toString('hex');
                      
                      // Extract the index from the account data
                      // Only attempt this if the data is long enough
                      if (data.length < 8 + 32 + 4) {
                        console.log(`Account data not long enough to contain encrypted output length`);
                        continue;
                      }
                      
                      const encryptedOutputLengthOffset = 8 + 32; // After discriminator and commitment
                      const encryptedOutputLength = data.readUInt32LE(encryptedOutputLengthOffset);
                      console.log(`Encrypted output length: ${encryptedOutputLength}`);
                      
                      // Check if data is long enough to contain index
                      if (data.length < encryptedOutputLengthOffset + 4 + encryptedOutputLength + 8) {
                        console.log(`Account data not long enough to contain index`);
                        continue;
                      }
                      
                      // Index starts after encrypted_output
                      const indexOffset = encryptedOutputLengthOffset + 4 + encryptedOutputLength;
                      const indexBuffer = data.slice(indexOffset, indexOffset + 8);
                      const index = BigInt(indexBuffer.readBigUInt64LE(0));
                      
                      console.log(`Extracted commitment: ${commitmentHex} with index: ${index}`);
                      
                      // Add commitment to Merkle tree with its index
                      const added = commitmentTreeService.addCommitment(commitmentHex, index);
                      console.log(`Added to tree: ${added ? 'success' : 'failed'}`);
                      
                      // Process the PDA through the existing service
                      processNewPDA(potentialPDA, data);
                    } catch (err) {
                      console.error(`Error processing potential PDA ${potentialPDA}:`, err);
                    }
                  }
                }
              } else {
                console.log(`Instruction data too short: ${data.length} bytes`);
              }
            }
          } else {
            console.log(`No instructions found for our program in transaction ${signature}`);
          }
        } else {
          console.log(`No instructions in transaction ${signature}`);
        }
      } catch (err) {
        console.error('Error processing transaction:', err);
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