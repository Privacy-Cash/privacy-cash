import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { readFileSync } from 'fs';
import * as path from 'path';
import { AnchorProvider, Program, Wallet } from '@coral-xyz/anchor';
import BN from 'bn.js';
import bs58 from 'bs58';

// Program ID for the zkcash program on mainnet
const PROGRAM_ID = new PublicKey('9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD');

// USDT mint address on mainnet
const USDT_MINT = new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');

// Maximum deposit amount: 200,000 USDT (6 decimals)
const MAX_DEPOSIT_AMOUNT = new BN(200_000_000_000);

// Squad vault authority on mainnet
const SQUAD_VAULT = new PublicKey('AWexibGxNFKTa1b5R5MN4PJr9HWnWRwf8EW9g8cLx3dM');

// Configure connection to Solana mainnet-beta
const connection = new Connection('https://rorie-6cdtt5-fast-mainnet.helius-rpc.com', 'confirmed');

async function generateSquadsTransaction() {
  // Load keypair for building instruction
  const anchorDirPath = path.join(__dirname, '..', 'anchor');
  const deployKeypairPath = path.join(anchorDirPath, 'deploy-keypair.json');
  const keypairJson = JSON.parse(readFileSync(deployKeypairPath, 'utf-8'));
  const payer = Keypair.fromSecretKey(Uint8Array.from(keypairJson));

  // Load IDL and setup program
  const idlPath = path.join(__dirname, '..', 'anchor', 'target', 'idl', 'zkcash.json');
  const idl = JSON.parse(readFileSync(idlPath, 'utf-8'));
  const wallet = new Wallet(payer);
  const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  const program = new Program(idl, provider);
  
  // Derive PDAs
  const [treeAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from('merkle_tree'), USDT_MINT.toBuffer()],
    PROGRAM_ID
  );

  const [globalConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from('global_config')],
    PROGRAM_ID
  );

  // Build the instruction
  const ix = await program.methods
    .initializeTreeAccountForSplToken(MAX_DEPOSIT_AMOUNT, null) // alt_address: null means no ALT set (backward compatible)
    .accounts({
      treeAccount: treeAccount,
      mint: USDT_MINT,
      globalConfig: globalConfig,
      authority: SQUAD_VAULT,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  // Create versioned transaction
  const { blockhash } = await connection.getLatestBlockhash();
  const messageV0 = new TransactionMessage({
    payerKey: SQUAD_VAULT,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();

  const transaction = new VersionedTransaction(messageV0);
  const serializedTx = transaction.serialize();

  // Output transaction in base58 format
  console.log(bs58.encode(serializedTx));
}

generateSquadsTransaction();
