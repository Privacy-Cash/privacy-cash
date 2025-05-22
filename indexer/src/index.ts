import Koa from 'koa';
import Router from '@koa/router';
import bodyParser from 'koa-bodyparser';
import { loadHistoricalPDAs, getAllCommitmentIds, getMerkleProof, getMerkleRoot } from './services/pda-service';
import { PROGRAM_ID, RPC_ENDPOINT, PORT } from './config';
import { commitmentTreeService } from './services/commitment-tree-service';
import { handleWebhook } from './controllers/webhook';

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

// Webhook endpoint for transaction updates
router.post('/zkcash/webhook/transaction', handleWebhook);

// Simple test endpoint that always returns 200
router.all('/test200', (ctx) => {
  ctx.status = 200;
  ctx.body = {
    message: 'This endpoint always returns 200 OK',
    method: ctx.method,
    path: ctx.path,
    headers: ctx.headers,
    body: ctx.request.body
  };
});

// Special test endpoint for Helius
router.post('/helius-test', (ctx) => {
  console.log('Helius test endpoint hit!');
  console.log('Headers:', JSON.stringify(ctx.request.headers, null, 2));
  console.log('Body:', JSON.stringify(ctx.request.body, null, 2));
  console.log('Method:', ctx.method);
  
  // Always return success
  ctx.status = 200;
  ctx.body = {
    success: true,
    message: 'Helius test received',
    receivedBody: ctx.request.body
  };
});

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
    await loadHistoricalPDAs();
    
    // Start server
    app.listen(PORT);
    console.log(`Server running on http://localhost:${PORT}`);
    
    // Re-load PDAs every 15 minutes
    setInterval(async () => {
      console.log('Reloading PDA data...');
      const ids = await loadHistoricalPDAs();
      console.log(`Loaded ${ids.length} commitment IDs`);
    }, 15 * 60 * 1000); // 15 minutes
    
    console.log('Ready to receive webhooks at /zkcash/webhook/transaction');
  } catch (error) {
    console.error('Failed to initialize:', error);
    process.exit(1);
  }
})(); 