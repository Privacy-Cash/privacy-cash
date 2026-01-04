import { 
  Connection, 
  Keypair, 
  PublicKey, 
  sendAndConfirmTransaction, 
  SystemProgram, 
  Transaction, 
  TransactionInstruction 
} from '@solana/web3.js';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

// Program ID for the zkcash SPL program
const PROGRAM_ID = new PublicKey('Bm7vFJy5o9dVDeKppL1HaoNBD14BKp92cxgwV5bhv7vr');

// Fee rates in basis points (1 basis point = 0.01%, 10000 = 100%)
export const DEPOSIT_FEE_RATE = 0; // 0% - Free deposits
export const WITHDRAW_FEE_RATE = 35; // 0.35% - Fee on withdrawals (35 basis points)
export const FEE_ERROR_MARGIN = 500; // 5% tolerance (minimum fee = 95% of expected)

// Tree configuration constants
export const DEFAULT_TREE_HEIGHT = 30; // Merkle tree height (supports 2^30 = ~1B leaves)
export const DEFAULT_ROOT_HISTORY_SIZE = 100; // Root history size

// Configure connection to Solana devnet
const connection = new Connection('https://domini-i2gp2o-fast-devnet.helius-rpc.com', 'confirmed');

// Anchor program initialize instruction discriminator
// This is the first 8 bytes of the SHA256 hash of "global:initialize"
const INITIALIZE_IX_DISCRIMINATOR = Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]);

/**
 * Initialize the Privacy Cash SPL program on devnet.
 * 
 * Key differences from the older version:
 * - NO tree_token_account (removed in SPL version)
 * - Only initializes: global_config and tree_account
 * - Uses global_config as the authority for token operations
 */
async function initialize() {
  try {
    // Load wallet keypair (for paying transaction fees)
    let payer: Keypair;
    
    try {
      const anchorDirPath = path.join(__dirname, '..', 'anchor', 'spl');
      const deployKeypairPath = path.join(anchorDirPath, 'deploy-keypair.json');
      const keypairJson = JSON.parse(readFileSync(deployKeypairPath, 'utf-8'));
      payer = Keypair.fromSecretKey(Uint8Array.from(keypairJson));
      console.log('✓ Using deploy-keypair.json from anchor/spl directory');
    } catch (err) {
      console.error('❌ Could not load deploy-keypair.json from anchor/spl directory');
      console.error('   Make sure the file exists at: anchor/spl/deploy-keypair.json');
      return;
    }

    console.log(`\n🔑 Authority/Payer: ${payer.publicKey.toString()}`);

    // Check wallet balance
    const balance = await connection.getBalance(payer.publicKey);
    console.log(`💰 Wallet balance: ${balance / 1e9} SOL`);

    if (balance === 0) {
      console.error('❌ Wallet has no SOL. Please fund your wallet before initializing the program.');
      console.log(`   Airdrop SOL: solana airdrop 2 ${payer.publicKey.toString()} --url devnet`);
      return;
    }
    
    // Derive PDAs (Program Derived Addresses)
    const [treeAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from('merkle_tree')],
      PROGRAM_ID
    );

    const [globalConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from('global_config')],
      PROGRAM_ID
    );

    console.log('\n📋 Generated PDAs:');
    console.log(`   Tree Account (Merkle Tree): ${treeAccount.toString()}`);
    console.log(`   Global Config: ${globalConfig.toString()}`);

    // Check if accounts already exist
    const treeAccountInfo = await connection.getAccountInfo(treeAccount);
    const globalConfigInfo = await connection.getAccountInfo(globalConfig);
    
    if (treeAccountInfo || globalConfigInfo) {
      console.log('\n⚠️  Program already initialized on devnet!');
      console.log('📦 Existing accounts:');
      if (globalConfigInfo) {
        console.log(`   ✓ Global Config: ${globalConfig.toString()}`);
        console.log(`     View: https://explorer.solana.com/address/${globalConfig.toString()}?cluster=devnet`);
      }
      if (treeAccountInfo) {
        console.log(`   ✓ Tree Account: ${treeAccount.toString()}`);
        console.log(`     View: https://explorer.solana.com/address/${treeAccount.toString()}?cluster=devnet`);
      }
      console.log('\n💡 If you need to reinitialize, you must first close these accounts or deploy with a different program ID.');
      return;
    }

    console.log('\n✓ Accounts do not exist. Proceeding with initialization...');

    // Create instruction data - only discriminator (initialize takes no parameters in SPL version)
    const data = INITIALIZE_IX_DISCRIMINATOR;

    // Create the initialize instruction
    // IMPORTANT: SPL version only has 4 accounts (removed tree_token_account)
    const initializeIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        // global_config (init, writable)
        { pubkey: globalConfig, isSigner: false, isWritable: true },
        // tree_account (init, writable)
        { pubkey: treeAccount, isSigner: false, isWritable: true },
        // authority (signer, writable - pays for account creation)
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        // system_program (readonly)
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    console.log('\n📤 Sending initialization transaction...');

    // Create and send transaction
    const transaction = new Transaction().add(initializeIx);
    
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    transaction.feePayer = payer.publicKey;
    
    const txSignature = await sendAndConfirmTransaction(connection, transaction, [payer]);
    
    console.log('\n✅ Initialization successful!');
    console.log('='.repeat(80));
    console.log(`📝 Transaction signature: ${txSignature}`);
    console.log(`🔗 Explorer: https://explorer.solana.com/tx/${txSignature}?cluster=devnet`);
    console.log('='.repeat(80));

    console.log('\n📊 Initialized accounts:');
    console.log(`   ✓ Global Config: ${globalConfig.toString()}`);
    console.log(`     - Deposit fee rate: ${DEPOSIT_FEE_RATE} basis points (${DEPOSIT_FEE_RATE / 100}%)`);
    console.log(`     - Withdrawal fee rate: ${WITHDRAW_FEE_RATE} basis points (${WITHDRAW_FEE_RATE / 100}%)`);
    console.log(`     - Fee error margin: ${FEE_ERROR_MARGIN} basis points (${FEE_ERROR_MARGIN / 100}%)`);
    console.log(`   ✓ Tree Account: ${treeAccount.toString()}`);
    console.log(`     - Height: ${DEFAULT_TREE_HEIGHT} (capacity: ${Math.pow(2, DEFAULT_TREE_HEIGHT).toLocaleString()} leaves)`);
    console.log(`     - Root history size: ${DEFAULT_ROOT_HISTORY_SIZE}`);

    console.log('\n📌 Important Notes:');
    console.log('   • Tree token accounts (ATAs) are created lazily per SPL token during first transaction');
    console.log('   • To initialize a specific SPL token ATA, run initialize_tree_ata_devnet.ts');
    console.log('   • Fee recipient ATAs must exist before transactions can be processed');

    console.log('\n🎯 Next steps:');
    console.log('   1. Initialize USDC tree ATA: npx ts-node scripts/initialize_tree_ata_devnet.ts');
    console.log('   2. Create Address Lookup Table: npx ts-node scripts/create_alt_devnet.ts');
    console.log('   3. Test deposits and withdrawals');

  } catch (error: any) {
    console.error('\n❌ Error initializing program:', error);
    
    // Provide helpful error messages
    if (error.message?.includes('already in use')) {
      console.log('\n💡 Account already exists. The program may have been initialized previously.');
    } else if (error.message?.includes('Unauthorized')) {
      console.log('\n💡 Unauthorized: Make sure you are using the correct authority keypair.');
      console.log(`   Expected authority: 97rSMQUukMDjA7PYErccyx7ZxbHvSDaeXp2ig5BwSrTf (devnet)`);
    } else if (error.logs) {
      console.log('\n📋 Transaction logs:');
      error.logs.forEach((log: string) => console.log(`   ${log}`));
    }
  }
}

console.log('╔═══════════════════════════════════════════════════════════════════════╗');
console.log('║   Privacy Cash Protocol - SPL Program Initialization (Devnet)        ║');
console.log('╚═══════════════════════════════════════════════════════════════════════╝\n');

// Run the initialize function
initialize();

