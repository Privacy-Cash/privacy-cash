import Koa from 'koa';
import Router from 'koa-router';
import bodyParser from 'koa-bodyparser';
import { PORT } from './config';
import { handleWebhook } from './controllers/webhook';
import { loadHistoricalPDAs, getAllCommitmentIds } from './services/pda-service';

const app = new Koa();
const router = new Router();

// Middleware
app.use(bodyParser());

// Routes
router.get('/', async (ctx) => {
  ctx.body = {
    status: 'success',
    message: 'Welcome to the ZKCash Indexer API'
  };
});

// Health check endpoint
router.get('/health', async (ctx) => {
  ctx.body = {
    status: 'ok',
    timestamp: new Date().toISOString()
  };
});

// Endpoint to get all commitment IDs
router.get('/commitments', async (ctx) => {
  ctx.body = {
    status: 'success',
    data: getAllCommitmentIds()
  };
});

// Webhook endpoint for Helius
router.post('/webhook', handleWebhook);

// Register router
app.use(router.routes()).use(router.allowedMethods());

// Error handling
app.on('error', (err, ctx) => {
  console.error('Server error:', err);
});

// Initialize: Load historical PDAs on startup
(async () => {
  try {
    // Load historical data
    await loadHistoricalPDAs();
    
    // Start server
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
      console.log(`Loaded ${getAllCommitmentIds().length} commitment IDs`);
      console.log('Ready to receive webhooks at /webhook');
    });
  } catch (error) {
    console.error('Failed to initialize:', error);
    process.exit(1);
  }
})();

export default app; 