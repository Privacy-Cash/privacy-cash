import Koa from 'koa';
import Router from '@koa/router';
import bodyParser from 'koa-bodyparser';
import { loadHistoricalPDAs, getAllCommitmentIds, getMerkleProof, getMerkleRoot, hasEncryptedOutput, getAllEncryptedOutputs, getMerkleProofByIndex } from './services/pda-service';
import { PROGRAM_ID, RPC_ENDPOINT, PORT } from './config';
import { commitmentTreeService } from './services/commitment-tree-service';
import { handleWebhook, reloadCommitmentsAndUxto } from './controllers/webhook';

// Define types for request bodies
interface WebhookRequest {
  pubkey: string;
  accountData: string;
}

// Initialize the application
const app = new Koa();
const router = new Router();

// Add global error handling
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    console.error('Unhandled error in request:', err);
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
  ctx.body = {
    root
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

// Webhook endpoint for transaction updates
router.post('/zkcash/webhook/transaction', handleWebhook);

// Configure routes
app.use(router.routes());
app.use(router.allowedMethods());

// Start the server
(async () => {
  try {
    console.log('Loading .env from:', process.env.DOTENV_CONFIG_PATH || '.env');
    console.log('Environment variables:');
    console.log(`- PROGRAM_ID: ${PROGRAM_ID}`);
    console.log(`- PORT: ${PORT}`);
    console.log(`- RPC_ENDPOINT: ${RPC_ENDPOINT}`);
    console.log(`Using RPC endpoint: ${RPC_ENDPOINT}`);
    
    // Load historical PDAs
    await reloadCommitmentsAndUxto();
    
    // Start server
    app.listen(PORT);
    console.log(`Server running on http://localhost:${PORT}`);
    
    // Periodic reload PDAs every 60 minutes to handle the case where some transactions aren't caught up
    setInterval(() => {
      console.log('Scheduled PDA reload...');
      reloadCommitmentsAndUxto();
    }, 60 * 60 * 1000); // 60 minutes
    
    console.log('Ready to receive webhooks at /zkcash/webhook/transaction');
  } catch (error) {
    console.error('Failed to initialize:', error);
    process.exit(1);
  }
})(); 