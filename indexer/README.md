# ZKCash Indexer

This service indexes commitment PDAs created by the ZKCash Solana program and provides an API to access them.

## Features

- Historical data loading on startup
- Real-time updates via Helius webhooks
- API to retrieve commitment IDs
- Withdraw transaction relay service

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
   PROGRAM_ID=AW7zH2XvbZZuXtF7tcfCRzuny7L89GGqB3z3deGpejWQ
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
   - Webhook URL: `https://your-server.com/zkcash/webhook/transaction`
   - Account Addresses: Your program ID (`AW7zH2XvbZZuXtF7tcfCRzuny7L89GGqB3z3deGpejWQ`)
   - Transaction Type: `Raw` 
   - Network: `devnet` (or the network where your program is deployed)

The webhook will:
1. Listen for transactions involving your program
2. Extract PDAs created from your 'transact' instruction
3. Parse the commitment from these PDAs
4. Add the commitment to the Merkle tree

## API Endpoints

### Core Endpoints
- `GET /` - Health check endpoint
- `GET /commitments` - Returns a list of all commitment IDs
- `GET /merkle/root` - Returns the current Merkle tree root and nextIndex
- `GET /merkle/proof/:commitment` - Returns the Merkle proof for a specific commitment
- `GET /merkle/proof/index/:index` - Returns the Merkle proof for a specific index
- `GET /utxos/check/:encryptedOutput` - Check if an encrypted output exists
- `GET /utxos` - Get all encrypted outputs
- `POST /zkcash/webhook/transaction` - Webhook endpoint for Helius transactions

### Withdraw Endpoints
- `POST /withdraw` - Submit a withdraw transaction (relayed by indexer)
- `GET /relayer` - Get relayer public key information

The withdraw endpoint expects a payload with the same structure as deposit transactions:
```json
{
  "serializedProof": "base64-encoded-proof-and-extdata",
  "treeAccount": "PublicKey",
  "nullifier0PDA": "PublicKey", 
  "nullifier1PDA": "PublicKey",
  "commitment0PDA": "PublicKey",
  "commitment1PDA": "PublicKey",
  "treeTokenAccount": "PublicKey",
  "recipient": "PublicKey",
  "feeRecipientAccount": "PublicKey",
  "deployer": "PublicKey",
  "extAmount": 123456,
  "encryptedOutput1": "base64-encoded-data",
  "encryptedOutput2": "base64-encoded-data", 
  "fee": 10000
}
```

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

Adjust the parsing in `src/services/pda-service.ts` and `src/controllers/webhook.ts` if your account structure differs.

### Relayer Setup

The relayer uses a dedicated keypair stored in `relayer_fee_payer_keypair.json`:
- **Purpose**: Signs and pays fees for withdraw transactions submitted to the indexer
- **Pattern**: Uses the same transaction structure as deposits but relayed through the indexer 