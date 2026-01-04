import { 
  Connection, 
  Keypair, 
  PublicKey, 
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram
} from '@solana/web3.js';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as borsh from 'borsh';

dotenv.config();

// Load user keypair
const anchorDirPath = path.join(__dirname, '..', 'anchor');
const deployKeypairPath = path.join(anchorDirPath, 'deploy-keypair.json');
const keypairJson = JSON.parse(readFileSync(deployKeypairPath, 'utf-8'));
const user = Keypair.fromSecretKey(Uint8Array.from(keypairJson));

// Program ID for the zkcash program
const PROGRAM_ID = new PublicKey('Bm7vFJy5o9dVDeKppL1HaoNBD14BKp92cxgwV5bhv7vr');

// Configure connection to Solana devnet
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

// Anchor discriminator for heap_test instruction
// This is the first 8 bytes of sha256("global:heap_test")
function getHeapTestDiscriminator(): Buffer {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update('global:heap_test').digest();
  return hash.slice(0, 8);
}

async function testHeapAllocation(allocationSize: number): Promise<void> {
  console.log(`\n=== Testing heap allocation of ${allocationSize} bytes ===`);
  console.log(`Program ID: ${PROGRAM_ID.toBase58()}`);
  console.log(`Authority: ${user.publicKey.toBase58()}`);

  try {
    // Build the instruction data: discriminator (8 bytes) + length (u64, 8 bytes little-endian)
    const discriminator = getHeapTestDiscriminator();
    const lengthBuffer = Buffer.alloc(8);
    lengthBuffer.writeBigUInt64LE(BigInt(allocationSize));
    const instructionData = Buffer.concat([discriminator, lengthBuffer]);

    // Create the heap_test instruction
    const heapTestIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: user.publicKey, isSigner: false, isWritable: false }, // authority
      ],
      data: instructionData,
    });

    // Request more compute units and heap size
    const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: 400_000,
    });

    // Request heap frame (256KB = 262144 bytes)
    const requestHeapIx = ComputeBudgetProgram.requestHeapFrame({
      bytes: 256 * 1024,
    });

    // Build and send transaction
    const transaction = new Transaction()
      .add(computeBudgetIx)
      .add(requestHeapIx)
      .add(heapTestIx);

    console.log('Sending transaction...');
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [user],
      { commitment: 'confirmed' }
    );

    console.log(`✅ SUCCESS! Allocated ${allocationSize} bytes`);
    console.log(`Transaction signature: ${signature}`);
    console.log(`Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
  } catch (error: any) {
    console.error(`❌ FAILED to allocate ${allocationSize} bytes`);
    console.error('Error:', error.message || error);
    if (error.logs) {
      console.error('Program logs:', error.logs);
    }
  }
}

async function main() {
  console.log('=== Heap Allocator Test on Devnet ===\n');
  
  // Check balance
  const balance = await connection.getBalance(user.publicKey);
  console.log(`Wallet balance: ${balance / 1e9} SOL`);
  
  if (balance < 0.01 * 1e9) {
    console.error('Insufficient balance. Please fund the wallet with at least 0.01 SOL');
    return;
  }

  // Test 1: Small allocation (should work with default 32KB heap)
  await testHeapAllocation(10_000); // 10 KB

  // Test 2: Medium allocation (requires custom heap > 32KB)
  await testHeapAllocation(50_000); // 50 KB

  // Test 3: Large allocation (requires 256KB heap)
  await testHeapAllocation(200_000); // 200 KB

  console.log('\n=== Test Complete ===');
  console.log('If all allocations succeeded, the custom heap allocator is working!');
}

main().catch(console.error);

