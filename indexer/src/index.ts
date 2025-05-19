import Koa from 'koa';
import Router from 'koa-router';
import bodyParser from 'koa-bodyparser';

const app = new Koa();
const router = new Router();
const PORT = process.env.PORT || 9001;

// Middleware
app.use(bodyParser());

// Routes
router.get('/', async (ctx) => {
  ctx.body = {
    status: 'success',
    message: 'Welcome to the Indexer API'
  };
});

// Health check endpoint
router.get('/health', async (ctx) => {
  ctx.body = {
    status: 'ok',
    timestamp: new Date().toISOString()
  };
});

// Register router
app.use(router.routes()).use(router.allowedMethods());

// Error handling
app.on('error', (err, ctx) => {
  console.error('Server error:', err);
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

export default app; 