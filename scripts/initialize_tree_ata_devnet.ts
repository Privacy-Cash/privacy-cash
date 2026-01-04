import { 
  Connection, 
  Keypair, 
  PublicKey, 
  sendAndConfirmTransaction, 
  SystemProgram, 
  Transaction, 
  TransactionInstruction 
} from '@solana/web3.js';
import { 
  TOKEN_PROGRAM_ID, 
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress 
} from '@solana/spl-token';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

// Program ID for the zkcash SPL program
const PROGRAM_ID = new PublicKey('Bm7vFJy5o9dVDeKppL1HaoNBD14BKp92cxgwV5bhv7vr');

// USDC mint address
// IMPORTANT!!!!!!!: Change it back to EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v after devnet testing is done!!!!!!!
const USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

// Configure connection to Solana devnet
const connection = new Connection('https://domini-i2gp2o-fast-devnet.helius-rpc.com', 'confirmed');

// Anchor program initialize_tree_account_for_spl_token instruction discriminator
// Generated from IDL
const INITIALIZE_TREE_ATA_DISCRIMINATOR = Buffer.from([19, 59, 201, 78, 69, 86, 50, 209]);

/**
 * Initialize the tree's associated token account (ATA) for a specific SPL token.
 * This is optional since ATAs are created lazily (init_if_needed) during transactions,
 * but doing it upfront can be useful for verification.
 */
async function initializeTreeAta(mintAddress: PublicKey, mintName: string = 'Token') {
  try {
    // Load wallet keypair (for paying transaction fees)
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

    if (balance < 0.01 * 1e9) {
      console.error('❌ Insufficient balance. Need at least 0.01 SOL for ATA creation.');
      console.log(`   Airdrop SOL: solana airdrop 2 ${authority.publicKey.toString()} --url devnet`);
      return;
    }
    
    // Derive PDAs
    const [globalConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from('global_config')],
      PROGRAM_ID
    );

    // Check if global_config exists
    const globalConfigInfo = await connection.getAccountInfo(globalConfig);
    if (!globalConfigInfo) {
      console.error('\n❌ Global config not found! Initialize the program first.');
      console.log('   Run: npx ts-node scripts/initialize_devnet.ts');
      return;
    }

    // Calculate the tree's ATA for this mint
    const treeAta = await getAssociatedTokenAddress(
      mintAddress,
      globalConfig,
      true // allowOwnerOffCurve (global_config is a PDA)
    );

    console.log(`\n📋 Addresses:`);
    console.log(`   Mint (${mintName}): ${mintAddress.toString()}`);
    console.log(`   Global Config: ${globalConfig.toString()}`);
    console.log(`   Tree ATA: ${treeAta.toString()}`);

    // Check if ATA already exists
    const ataInfo = await connection.getAccountInfo(treeAta);
    
    if (ataInfo) {
      console.log('\n✓ Tree ATA already exists!');
      console.log(`   View: https://explorer.solana.com/address/${treeAta.toString()}?cluster=devnet`);
      return;
    }

    console.log('\n📤 Creating tree ATA for this SPL token...');

    // Create the instruction
    // Accounts for InitializeTreeAccountForSplToken:
    // 1. mint
    // 2. global_config
    // 3. tree_ata (will be created by init constraint)
    // 4. authority (signer, payer)
    // 5. token_program
    // 6. associated_token_program
    // 7. system_program
    const initializeTreeAtaIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        // mint (readonly)
        { pubkey: mintAddress, isSigner: false, isWritable: false },
        // global_config (readonly, PDA)
        { pubkey: globalConfig, isSigner: false, isWritable: false },
        // tree_ata (init, writable)
        { pubkey: treeAta, isSigner: false, isWritable: true },
        // authority (signer, payer, writable)
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        // token_program (readonly)
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        // associated_token_program (readonly)
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        // system_program (readonly)
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: INITIALIZE_TREE_ATA_DISCRIMINATOR,
    });

    // Create and send transaction
    const transaction = new Transaction().add(initializeTreeAtaIx);
    
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    transaction.feePayer = authority.publicKey;
    
    const txSignature = await sendAndConfirmTransaction(connection, transaction, [authority]);
    
    console.log('\n✅ Tree ATA initialized successfully!');
    console.log('='.repeat(80));
    console.log(`📝 Transaction signature: ${txSignature}`);
    console.log(`🔗 Explorer: https://explorer.solana.com/tx/${txSignature}?cluster=devnet`);
    console.log('='.repeat(80));

    console.log(`\n📊 Tree ATA for ${mintName}:`);
    console.log(`   Address: ${treeAta.toString()}`);
    console.log(`   Owner (Authority): ${globalConfig.toString()}`);
    console.log(`   Mint: ${mintAddress.toString()}`);
    console.log(`   View: https://explorer.solana.com/address/${treeAta.toString()}?cluster=devnet`);

    console.log('\n✓ The protocol can now accept deposits and process withdrawals for this token!');

  } catch (error: any) {
    console.error('\n❌ Error initializing tree ATA:', error);
    
    // Provide helpful error messages
    if (error.message?.includes('already in use')) {
      console.log('\n💡 ATA already exists. This is normal if it was created previously or via init_if_needed.');
    } else if (error.message?.includes('Unauthorized')) {
      console.log('\n💡 Unauthorized: Make sure you are using the correct authority keypair.');
    } else if (error.message?.includes('InvalidMintAddress')) {
      console.log('\n💡 This mint is not in the allowed tokens list.');
    } else if (error.logs) {
      console.log('\n📋 Transaction logs:');
      error.logs.forEach((log: string) => console.log(`   ${log}`));
    }
  }
}

console.log('╔═══════════════════════════════════════════════════════════════════════╗');
console.log('║   Privacy Cash - Initialize Tree ATA for SPL Token (Devnet)          ║');
console.log('╚═══════════════════════════════════════════════════════════════════════╝\n');

// Initialize USDC tree ATA by default
console.log('🎯 Initializing tree ATA for USDC (Devnet)...\n');
initializeTreeAta(USDC_MINT, 'USDC');

// You can also call this function programmatically for other tokens:
// initializeTreeAta(new PublicKey('other_mint_address'), 'TokenName');

