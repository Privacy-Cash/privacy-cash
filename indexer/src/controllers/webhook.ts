import { Context } from 'koa';
import { processNewPDA } from '../services/pda-service';
import { PROGRAM_ID } from '../config';

interface HeliusWebhookPayload {
  accountData: Array<{
    pubkey: string;
    owner: string;
    data: string[];
    lamports?: number;
    executable?: boolean;
  }>;
}

/**
 * Handle Helius webhook payload
 * Documentation: https://docs.helius.dev/webhooks/webhook-payloads
 */
export async function handleWebhook(ctx: Context): Promise<void> {
  try {
    const payload = ctx.request.body as HeliusWebhookPayload;
    
    // Check if this is a valid webhook payload
    if (!payload || !Array.isArray(payload.accountData)) {
      ctx.status = 400;
      ctx.body = { success: false, error: 'Invalid webhook payload' };
      return;
    }
    
    console.log(`Received webhook with ${payload.accountData.length} account updates`);
    
    // Process each account update
    for (const accountData of payload.accountData) {
      // Ensure this account belongs to our program
      if (accountData.owner === PROGRAM_ID.toString()) {
        // Check if this is a commitment account by its data size or pattern
        // You might need additional filtering based on your account structure
        
        // Process the account
        const accountPubkey = accountData.pubkey;
        const accountDataBuffer = Buffer.from(accountData.data[0], 'base64');
        
        processNewPDA(accountPubkey, accountDataBuffer);
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