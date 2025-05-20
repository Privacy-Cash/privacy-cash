import dotenv from 'dotenv';
import { Connection, PublicKey } from '@solana/web3.js';

// Load environment variables
dotenv.config();

// Constants
export const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID!);
export const PORT = parseInt(process.env.PORT!);
export const RPC_ENDPOINT = process.env.RPC_ENDPOINT || 'https://devnet.helius-rpc.com/?api-key=YOUR_HELIUS_API_KEY';

// Create a connection to the Solana cluster
export const connection = new Connection(RPC_ENDPOINT); 