import { 
  Connection, 
  Keypair, 
  PublicKey, 
  sendAndConfirmTransaction, 
  Transaction, 
  TransactionInstruction 
} from '@solana/web3.js';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import BN from 'bn.js';

dotenv.config();

// Program ID for the zkcash SPL program
const PROGRAM_ID = new PublicKey('9buNGKLVHL9PDmGKCBQwtAXiGVaqmYHgup9gJYySRDxt');

// Configure connection to Solana devnet using Helius RPC
const connection = new Connection('https://domini-i2gp2o-fast-devnet.helius-rpc.com', 'confirmed');

// Anchor program update_deposit_limit_for_spl_token instruction discriminator
// From IDL: [248, 7, 11, 9, 68, 132, 16, 102]
const UPDATE_DEPOSIT_LIMIT_FOR_SPL_TOKEN_DISCRIMINATOR = Buffer.from([248, 7, 11, 9, 68, 132, 16, 102]);

// Common SPL token mints (devnet addresses)
const TOKEN_MINTS: { [key: string]: PublicKey } = {
  'USDC': new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
  'USDT': new PublicKey('EcFc2cMyZxaKBkFK1XooxiyDyCPneLXiMwSJiVY6eTad'),
  'ORE': new PublicKey('6zxkY8UygHKBf64LJDXnzcYr9wdvyqScmj7oGPBFw58Z'),
  'ZEC': new PublicKey('Vu3Lcx3chdCHmy9KCCdd19DdJsLejHAZxm1E1bTgE16'),
};

/**
 * Update the deposit limit for a specific SPL token.
 * 
 * @param mintAddress - The mint address of the SPL token
 * @param newLimit - The new deposit limit in base units (e.g., lamports for SOL, smallest unit for tokens)
 * @param mintName - Optional name for display purposes
 */
async function updateSplTokenDepositLimit(
  mintAddress: PublicKey, 
  newLimit: BN,
  mintName: string = 'Token'
) {
  try {
    // Load wallet keypair (for paying transaction fees and as authority)
    let authority: Keypair;
    
    try {
      const anchorDirPath = path.join(__dirname, '..', 'anchor', 'spl');
      const deployKeypairPath = path.join(anchorDirPath, 'deploy-keypair.json');
      const keypairJson = JSON.parse(readFileSync(deployKeypairPath, 'utf-8'));
      authority = Keypair.fromSecretKey(Uint8Array.from(keypairJson));
      console.log('✓ Using deploy-keypair.json from anchor/spl directory');
    } catch (err) {
      console.error('❌ Could not load deploy-keypair.json from anchor/spl directory');
      console.error('   Make sure the file exists at: anchor/spl/deploy-keypair.json');
      return;
    }

    console.log(`\n🔑 Authority: ${authority.publicKey.toString()}`);

    // Check wallet balance
    const balance = await connection.getBalance(authority.publicKey);
    console.log(`💰 Wallet balance: ${balance / 1e9} SOL`);

    if (balance < 0.001 * 1e9) {
      console.error('❌ Insufficient balance. Need at least 0.001 SOL for transaction fees.');
      console.log(`   Airdrop SOL: solana airdrop 2 ${authority.publicKey.toString()} --url devnet`);
      return;
    }
    
    // Derive the tree_account PDA for this SPL token
    // Seeds: ["merkle_tree", mint_pubkey]
    const [treeAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from('merkle_tree'), mintAddress.toBuffer()],
      PROGRAM_ID
    );

    console.log(`\n📋 Addresses:`);
    console.log(`   Mint (${mintName}): ${mintAddress.toString()}`);
    console.log(`   Tree Account (PDA): ${treeAccount.toString()}`);

    // Check if tree_account exists
    const treeAccountInfo = await connection.getAccountInfo(treeAccount);
    if (!treeAccountInfo) {
      console.error('\n❌ Tree account not found for this SPL token!');
      console.log('   The SPL token tree may not have been initialized yet.');
      console.log('   Run initialize_tree_ata_devnet.ts first for this token.');
      return;
    }

    console.log(`\n📊 New Deposit Limit: ${newLimit.toString()} (smallest units)`);
    
    // For USDC/USDT with 6 decimals, show human-readable amount
    const decimals = 6; // Most stablecoins have 6 decimals
    const humanReadableLimit = newLimit.div(new BN(10).pow(new BN(decimals))).toString();
    console.log(`   Human readable (${decimals} decimals): ${humanReadableLimit} ${mintName}`);

    console.log('\n📤 Sending update_deposit_limit_for_spl_token transaction...');

    // Create instruction data: discriminator + new_limit (u64, little-endian)
    const newLimitBuffer = Buffer.alloc(8);
    newLimitBuffer.writeBigUInt64LE(BigInt(newLimit.toString()));
    const data = Buffer.concat([
      UPDATE_DEPOSIT_LIMIT_FOR_SPL_TOKEN_DISCRIMINATOR,
      newLimitBuffer
    ]);

    // Create the instruction
    // Accounts for UpdateDepositLimitForSplToken:
    // 1. tree_account (mut, PDA with seeds ["merkle_tree", mint])
    // 2. mint (readonly)
    // 3. authority (signer)
    const updateLimitIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        // tree_account (writable, PDA)
        { pubkey: treeAccount, isSigner: false, isWritable: true },
        // mint (readonly)
        { pubkey: mintAddress, isSigner: false, isWritable: false },
        // authority (signer)
        { pubkey: authority.publicKey, isSigner: true, isWritable: false },
      ],
      data,
    });

    // Create and send transaction
    const transaction = new Transaction().add(updateLimitIx);
    
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    transaction.feePayer = authority.publicKey;
    
    const txSignature = await sendAndConfirmTransaction(connection, transaction, [authority]);
    
    console.log('\n✅ Deposit limit updated successfully!');
    console.log('='.repeat(80));
    console.log(`📝 Transaction signature: ${txSignature}`);
    console.log(`🔗 Explorer: https://explorer.solana.com/tx/${txSignature}?cluster=devnet`);
    console.log('='.repeat(80));

    console.log(`\n📊 Updated Configuration for ${mintName}:`);
    console.log(`   Tree Account: ${treeAccount.toString()}`);
    console.log(`   New Deposit Limit: ${newLimit.toString()} (smallest units)`);
    console.log(`   Human Readable: ${humanReadableLimit} ${mintName}`);

  } catch (error: any) {
    console.error('\n❌ Error updating deposit limit:', error);
    
    // Provide helpful error messages
    if (error.message?.includes('Unauthorized')) {
      console.log('\n💡 Unauthorized: Make sure you are using the correct authority keypair.');
      console.log('   The authority must match the one used to initialize the tree account.');
    } else if (error.message?.includes('AccountNotFound')) {
      console.log('\n💡 Account not found: The tree account for this SPL token may not exist.');
      console.log('   Initialize the tree first using initialize_tree_ata_devnet.ts');
    } else if (error.logs) {
      console.log('\n📋 Transaction logs:');
      error.logs.forEach((log: string) => console.log(`   ${log}`));
    }
  }
}

// Parse command line arguments
function parseArgs(): { mint: PublicKey; limit: BN; name: string } | null {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.log('Usage: npx ts-node update_spl_token_deposit_limit_devnet.ts <token_name_or_mint> <new_limit>');
    console.log('\nExamples:');
    console.log('  npx ts-node update_spl_token_deposit_limit_devnet.ts USDC 1000000000000');
    console.log('  npx ts-node update_spl_token_deposit_limit_devnet.ts 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU 1000000000000');
    console.log('\nSupported token names (devnet):');
    Object.entries(TOKEN_MINTS).forEach(([name, mint]) => {
      console.log(`  ${name}: ${mint.toString()}`);
    });
    console.log('\nNote: The limit is in the smallest unit (e.g., 1000000 = 1 USDC with 6 decimals)');
    return null;
  }

  const tokenArg = args[0].toUpperCase();
  const limitArg = args[1];

  // Try to get mint from known tokens or parse as pubkey
  let mint: PublicKey;
  let name: string;
  
  if (TOKEN_MINTS[tokenArg]) {
    mint = TOKEN_MINTS[tokenArg];
    name = tokenArg;
  } else {
    try {
      mint = new PublicKey(args[0]);
      name = 'Custom Token';
    } catch {
      console.error(`❌ Invalid token: ${args[0]}`);
      console.log('   Provide a valid token name (USDC, USDT, ORE, ZEC) or a valid mint address.');
      return null;
    }
  }

  // Parse limit
  let limit: BN;
  try {
    limit = new BN(limitArg);
    if (limit.isNeg()) {
      console.error('❌ Deposit limit must be a positive number');
      return null;
    }
  } catch {
    console.error(`❌ Invalid limit: ${limitArg}`);
    console.log('   Provide a valid positive integer for the deposit limit.');
    return null;
  }

  return { mint, limit, name };
}

// Main execution
console.log('╔═══════════════════════════════════════════════════════════════════════╗');
console.log('║   Privacy Cash - Update SPL Token Deposit Limit (Devnet)             ║');
console.log('╚═══════════════════════════════════════════════════════════════════════╝\n');

const parsed = parseArgs();
if (parsed) {
  console.log(`🎯 Updating deposit limit for ${parsed.name}...`);
  updateSplTokenDepositLimit(parsed.mint, parsed.limit, parsed.name);
}

