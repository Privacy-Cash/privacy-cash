# ZKCash Indexer

This service indexes commitment PDAs created by the ZKCash Solana program and provides an API to access them.

## Features

- Historical data loading on startup
- Real-time updates via Helius webhooks
- API to retrieve commitment IDs

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create a `.env` file with the following content:
   ```
   # Solana RPC Configuration
   RPC_ENDPOINT=https://devnet.helius-rpc.com/?api-key=YOUR_HELIUS_API_KEY

   # Program ID
   PROGRAM_ID=BByY3XVe36QEn3omkkzZM7rst2mKqt4S4XMCrbM9oUTh

   # Server Configuration
   PORT=9001
   ```

3. Build the project:
   ```bash
   npm run build
   ```

4. Start the server:
   ```bash
   npm start
   ```

## Setting up Helius Webhook

1. Go to the [Helius Dashboard](https://dev.helius.xyz/dashboard) and create a new webhook.
2. Use the following webhook settings:
   - Webhook URL: `https://your-server.com/webhook`
   - Account Addresses: Your program ID (`BByY3XVe36QEn3omkkzZM7rst2mKqt4S4XMCrbM9oUTh`)
   - Event Types: `accountData` 
   - Network: `devnet` (or the network where your program is deployed)

## API Endpoints

- `GET /health` - Health check endpoint
- `GET /commitments` - Returns a list of all commitment IDs
- `POST /webhook` - Webhook endpoint for Helius

## Development

For local development, you can run:
```bash
npm run dev
```

## Notes on Account Data Structure

This indexer expects commitment accounts with the following Anchor-generated structure:
- 8 bytes discriminator
- 32 bytes commitment
- Variable length encrypted_output (with 4-byte length prefix)
- 8 bytes index
- 1 byte bump

Adjust the parsing in `src/services/pda-service.ts` if your account structure differs. 