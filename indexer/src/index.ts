import Koa from 'koa';
import Router from '@koa/router';
import bodyParser from 'koa-bodyparser';
import cors from '@koa/cors';
import { logger } from './utils/logger';
import { getAllCommitmentIds, getMerkleProof, getMerkleRoot, getNextIndex, hasEncryptedOutput, getAllEncryptedOutputs, getMerkleProofByIndex } from './services/pda-service';
import { PROGRAM_ID, RPC_ENDPOINT, PORT } from './config';
import { handleWebhook, reloadCommitmentsAndUxto } from './controllers/webhook';
import { handleWithdraw, getRelayerInfo } from './controllers/withdraw';
import { userUxtosService } from './services/user-uxtos-service';

// Define types for request bodies
interface WebhookRequest {
  pubkey: string;
  accountData: string;
}

/**
 * Handle UTXOs range request with parameter validation
 * @param startParam The start parameter as string
 * @param endParam The end parameter as string
 * @returns Response object with data or error
 */
function handleUtxosRangeRequest(startParam: string | undefined, endParam: string | undefined): {
  success: boolean;
  status: number;
  data?: {
    encrypted_outputs: string[];
    hasMore: boolean;
    total: number;
    start: number;
    end: number;
  };
  error?: string;
} {
  try {
    if (!startParam || !endParam) {
      return {
        success: false,
        status: 400,
        error: 'Missing required parameters. Both start and end are required.'
      };
    }

    const start = parseInt(startParam);
    const end = parseInt(endParam,);

    if (isNaN(start) || isNaN(end)) {
      return {
        success: false,
        status: 400,
        error: 'Invalid parameters. Both start and end must be valid numbers.'
      };
    }

    // Validate parameter values
    if (start < 0) {
      return {
        success: false,
        status: 400,
        error: 'Start parameter must be non-negative.'
      };
    }

    if (end < start) {
      return {
        success: false,
        status: 400,
        error: 'End parameter must be greater than or equal to start parameter.'
      };
    }

    // Get the range data
    const result = userUxtosService.getEncryptedOutputsRange(start, end);
    
    return {
      success: true,
      status: 200,
      data: result
    };
  } catch (error) {
    logger.error('Error handling UTXOs range request:', error);
    return {
      success: false,
      status: 500,
      error: 'Internal server error'
    };
  }
}

// Initialize the application
const app = new Koa();
const router = new Router();

// Add global error handling
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    logger.error('Unhandled error in request:', err);
    ctx.status = 500;
    ctx.body = { 
      success: false, 
      error: 'Internal server error',
      path: ctx.path,
      method: ctx.method
    };
  }
});

// Configure middleware
// TODO: Only allow requests from the live.bet domain and localhost
app.use(cors({
  origin: '*',
  credentials: true
 }))
app.use(bodyParser());

// Define routes
router.get('/', (ctx) => {
  ctx.body = {
    name: 'ZKCash Indexer API',
    status: 'OK',
    version: '1.0.0',
    program_id: PROGRAM_ID
  };
});

// Get all commitment IDs
router.get('/commitments', (ctx) => {
  const commitments = getAllCommitmentIds();
  ctx.body = {
    count: commitments.length,
    commitments
  };
});

// Get the current Merkle tree root
router.get('/merkle/root', (ctx) => {
  const root = getMerkleRoot();
  const nextIndex = getNextIndex();
  ctx.body = {
    root,
    nextIndex
  };
});

// Get Merkle proof for a specific commitment
router.get('/merkle/proof/:commitment', (ctx) => {
  const commitment = ctx.params.commitment;
  const proof = getMerkleProof(commitment);
  
  if (proof) {
    ctx.body = proof;
  } else {
    ctx.status = 404;
    ctx.body = {
      error: 'Commitment not found in the Merkle tree'
    };
  }
});

// Get Merkle proof for a specific index
router.get('/merkle/proof/index/:index', (ctx) => {
  const index = parseInt(ctx.params.index, 10);
  
  if (isNaN(index)) {
    ctx.status = 400;
    ctx.body = {
      error: 'Invalid index parameter. Must be a number.'
    };
    return;
  }
  
  const pathElements = getMerkleProofByIndex(index);
  
  // Always return the proof - it will be a dummy proof if the index is invalid
  ctx.body = pathElements;
});

// Check if an encrypted output exists
router.get('/utxos/check/:encryptedOutput', (ctx) => {
  const encryptedOutput = ctx.params.encryptedOutput;
  const exists = hasEncryptedOutput(encryptedOutput);
  
  ctx.body = {
    exists
  };
});

// Get all encrypted outputs
router.get('/utxos', (ctx) => {
  const encryptedOutputs = getAllEncryptedOutputs();
  ctx.body = {
    count: encryptedOutputs.length,
    encrypted_outputs: encryptedOutputs
  };
});

// Get encrypted outputs in a range with pagination
router.get('/utxos/range', (ctx) => {
  const startParam = ctx.query.start as string;
  const endParam = ctx.query.end as string;
  
  const result = handleUtxosRangeRequest(startParam, endParam);
  
  ctx.status = result.status;
  if (result.success) {
    ctx.body = result.data;
  } else {
    ctx.body = {
      error: result.error
    };
  }
});

// Webhook endpoint for transaction updates
router.post('/zkcash/webhook/transaction', handleWebhook);

// Withdraw endpoints
router.post('/withdraw', handleWithdraw);
router.get('/relayer', getRelayerInfo);

// Configure routes
app.use(router.routes());
app.use(router.allowedMethods());

// Start the server
(async () => {
  try {
    // Load historical PDAs
    await reloadCommitmentsAndUxto();
    
    // Start server
    app.listen(PORT);
    logger.info(`Server running on http://localhost:${PORT}`);
    
    // Periodic reload PDAs every 60 minutes to handle the case where some transactions aren't caught up
    setInterval(() => {
      logger.info('Scheduled PDA reload...');
      reloadCommitmentsAndUxto();
    }, 60 * 60 * 1000); // 60 minutes
    
    logger.info('Ready to receive webhooks at /zkcash/webhook/transaction');
  } catch (error) {
    logger.error('Failed to initialize:', error);
    process.exit(1);
  }
})(); 