import { PublicKey } from '@solana/web3.js';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { Connection } from '@solana/web3.js';

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Default values
const DEFAULT_PROGRAM_ID = 'BByY3XVe36QEn3omkkzZM7rst2mKqt4S4XMCrbM9oUTh';
const DEFAULT_RPC_ENDPOINT = 'https://api.devnet.solana.com';

// Get environment variables or use defaults
export const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || DEFAULT_PROGRAM_ID);
export const PORT = 8888;
export const RPC_ENDPOINT = process.env.RPC_ENDPOINT || DEFAULT_RPC_ENDPOINT;

// Create a connection to the Solana network
export const connection = new Connection(RPC_ENDPOINT, 'confirmed');

// Log environment variables on startup
console.log('Environment variables:');
console.log(`- PROGRAM_ID: ${PROGRAM_ID.toString()}`);
console.log(`- PORT: ${PORT}`);
console.log(`- RPC_ENDPOINT: ${RPC_ENDPOINT}`); 