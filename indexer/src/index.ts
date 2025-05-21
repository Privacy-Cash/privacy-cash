import Koa from 'koa';
import Router from '@koa/router';
import bodyParser from 'koa-bodyparser';
import { loadHistoricalPDAs, getAllCommitmentIds, getMerkleProof, getMerkleRoot } from './services/pda-service';
import { PROGRAM_ID, RPC_ENDPOINT, PORT } from './config';
import { commitmentTreeService } from './services/commitment-tree-service';

// Define types for request bodies
interface WebhookRequest {
  pubkey: string;
  accountData: string;
}

// Initialize the application
const app = new Koa();
const router = new Router();

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

// Webhook endpoint for new PDA updates
router.post('/webhook', (ctx) => {
  // TODO: Add authentication for webhooks
  const { pubkey, accountData } = ctx.request.body as WebhookRequest;
  
  if (!pubkey || !accountData) {
    ctx.status = 400;
    ctx.body = {
      error: 'Missing required fields: pubkey and accountData'
    };
    return;
  }
  
  try {
    // Process the new PDA
    // In a production environment, you'd want to verify the data and add authentication
    // processNewPDA(pubkey, Buffer.from(accountData, 'base64'));
    
    ctx.body = {
      status: 'success',
      message: 'Webhook received'
    };
  } catch (error) {
    ctx.status = 500;
    ctx.body = {
      error: 'Failed to process webhook'
    };
  }
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
    
    console.log('Ready to receive webhooks at /webhook');
  } catch (error) {
    console.error('Failed to initialize:', error);
    process.exit(1);
  }
})(); 