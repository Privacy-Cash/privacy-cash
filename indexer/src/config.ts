import { PublicKey } from '@solana/web3.js';
import { Connection } from '@solana/web3.js';

// Default values
const DEFAULT_PROGRAM_ID = 'AW7zH2XvbZZuXtF7tcfCRzuny7L89GGqB3z3deGpejWQ';
const DEFAULT_RPC_ENDPOINT = 'https://api.devnet.solana.com';

// Get environment variables or use defaults
export const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || DEFAULT_PROGRAM_ID);
export const PORT = 8888;
export const RPC_ENDPOINT = process.env.RPC_ENDPOINT || DEFAULT_RPC_ENDPOINT;

// Create a connection to the Solana network
export const connection = new Connection(RPC_ENDPOINT, 'confirmed');