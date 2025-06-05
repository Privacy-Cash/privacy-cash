import { Context } from 'koa';
import { loadHistoricalPDAs } from '../services/pda-service';
import { PROGRAM_ID } from '../config';
import { userUxtosService } from '../services/user-uxtos-service';
import { logger } from '../utils/logger';

// Flag to track if a reload is already in progress
let reloadInProgress = false;
// Flag to indicate if another reload is needed after current one finishes
let reloadRequested = false;

/**
 * Handle Helius webhook payload
 * Documentation: https://docs.helius.dev/webhooks/webhook-payloads
 */
export async function handleWebhook(ctx: Context): Promise<void> {
  try {
    // Log the full request for debugging
    logger.info('--------- WEBHOOK REQUEST ---------', {
      headers: JSON.stringify(ctx.request.headers, null, 2),
      body: JSON.stringify(ctx.request.body, null, 2)
    });
    
    const payload = ctx.request.body;
    
    // Check if this is a valid webhook payload (an array from Helius)
    if (!Array.isArray(payload)) {
      logger.info('Invalid webhook payload format - expected array');
      ctx.status = 400;
      ctx.body = { success: false, error: 'Invalid webhook payload format - expected array' };
      return;
    }
    
    logger.info(`Received webhook with ${payload.length} transactions`);
    
    // Check if any of the transactions involve our program
    let relevantTransactionFound = false;
    
    for (const transaction of payload) {
      if (transaction.instructions) {
        const programInstructions = transaction.instructions.filter(
          (ix: any) => ix.programId === PROGRAM_ID.toString()
        );
        
        if (programInstructions.length > 0) {
          logger.info(`Found ${programInstructions.length} instructions for our program in transaction ${transaction.signature}`);
          relevantTransactionFound = true;
          break;
        }
      }
    }
    
    // If no relevant transactions found, we can skip reloading
    if (!relevantTransactionFound) {
      logger.info('No relevant transactions for our program found, skipping reload');
      ctx.status = 200;
      ctx.body = { success: true, message: 'No relevant transactions found' };
      return;
    }
    
    // Trigger a reload of all PDAs
    reloadCommitmentsAndUxto();
    
    // Respond with success
    ctx.status = 200;
    ctx.body = { success: true, message: 'Webhook received, PDA reload triggered' };
  } catch (error) {
    logger.error('Error handling webhook: ' + String(error));
    ctx.status = 500;
    ctx.body = { success: false, error: 'Internal server error' };
  }
}

/**
 * Trigger a reload of all PDAs
 * If a reload is already in progress, set a flag to trigger another reload after it completes
 */
export function reloadCommitmentsAndUxto(): void {
  if (reloadInProgress) {
    logger.info('PDA reload already in progress, queuing another reload for when it completes');
    reloadRequested = true;
    return;
  }
  
  reloadInProgress = true;
  logger.info('Starting PDA reload...');
  
  loadHistoricalPDAs()
    .then(() => {
      logger.info('PDA reload completed successfully');
      
      // Log the current state of encrypted outputs
      const count = userUxtosService.getEncryptedOutputCount();
      logger.info(`---------- ENCRYPTED OUTPUTS STATE ----------`);
      logger.info(`Total encrypted outputs: ${count}`);
      
      if (count > 0) {
        // Show last 10 outputs
        const outputs = userUxtosService.getAllEncryptedOutputs();
        // const lastOutputs = outputs.slice(0, 10);
        // logger.log(`Last ${lastOutputs.length} encrypted outputs:`);
        outputs.forEach((output, i) => {
          const index = outputs.length - i;
          logger.info(`  [${index}] ${output}`);
        });
        
        if (count > 10) {
          logger.info(`... and ${count - 10} more at the beginning`);
        }
      }
      logger.info(`----------- ENCRYPTED OUTPUTS FINISHED PROCESSING -------------`);
      
      reloadInProgress = false;
      
      // If another reload was requested while this one was running, trigger it now
      if (reloadRequested) {
        logger.info('Processing queued PDA reload request');
        reloadRequested = false;
        reloadCommitmentsAndUxto();
      }
    })
    .catch(error => {
      logger.error('Error during PDA reload:', error);
      reloadInProgress = false;
      
      // If another reload was requested, still try it despite the error
      if (reloadRequested) {
        logger.info('Processing queued PDA reload request after error');
        reloadRequested = false;
        reloadCommitmentsAndUxto();
      }
    });
} 