import { Context } from 'koa';
import { 
  submitWithdrawTransaction, 
  getRelayerPublicKey, 
  WithdrawParams 
} from '../services/withdraw-service';
import { logger } from '../utils/logger';

// Submit withdraw transaction endpoint
export async function handleWithdraw(ctx: Context) {
  try {
    // Validate request body
    const params = ctx.request.body as WithdrawParams;
    
    if (!params) {
      ctx.status = 400;
      ctx.body = {
        success: false,
        error: 'Request body is required'
      };
      return;
    }

    // Validate required fields based on new interface
    const requiredFields = [
      'serializedProof', 
      'treeAccount', 
      'nullifier0PDA',
      'nullifier1PDA',
      'commitment0PDA',
      'commitment1PDA',
      'treeTokenAccount',
      'recipient',
      'feeRecipientAccount',
      'deployer',
      'extAmount',
      'encryptedOutput1',
      'encryptedOutput2',
      'fee'
    ];
    
    const missingFields = requiredFields.filter(field => !params[field as keyof WithdrawParams]);
    
    if (missingFields.length > 0) {
      ctx.status = 400;
      ctx.body = {
        success: false,
        error: `Missing required fields: ${missingFields.join(', ')}`
      };
      return;
    }

    // Validate amounts
    if (typeof params.extAmount !== 'number') {
      ctx.status = 400;
      ctx.body = {
        success: false,
        error: 'extAmount must be a number'
      };
      return;
    }

    if (typeof params.fee !== 'number' || params.fee <= 0) {
      ctx.status = 400;
      ctx.body = {
        success: false,
        error: 'fee must be a positive number'
      };
      return;
    }

    logger.info('Received withdraw request:', {
      recipient: params.recipient,
      extAmount: params.extAmount,
      fee: params.fee,
      treeAccount: params.treeAccount
    });

    // Submit the withdraw transaction
    const signature = await submitWithdrawTransaction(params);

    ctx.body = {
      success: true,
      signature,
      message: 'Withdraw transaction submitted successfully'
    };

  } catch (error) {
    logger.error('Error handling withdraw request: ' + String(error));
    
    ctx.status = 500;
    ctx.body = {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to process withdraw request'
    };
  }
}

// Get relayer info endpoint
export async function getRelayerInfo(ctx: Context) {
  try {
    const publicKey = getRelayerPublicKey();

    ctx.body = {
      success: true,
      relayer: {
        publicKey: publicKey.toString()
      }
    };

  } catch (error) {
    logger.error('Error getting relayer info: ' + String(error));
    
    ctx.status = 500;
    ctx.body = {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get relayer information'
    };
  }
} 