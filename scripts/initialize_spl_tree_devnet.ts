import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, AddressLookupTableProgram, ComputeBudgetProgram } from '@solana/web3.js';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { AnchorProvider, Program, Wallet } from '@coral-xyz/anchor';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Buffer } from 'buffer';
import BN from 'bn.js';

export const FIELD_SIZE = new BN('21888242871839275222246405745257275088548364400416034343698204186575808495617')

// Fee recipient account for all transactions
export const FEE_RECIPIENT_ACCOUNT = new PublicKey('97rSMQUukMDjA7PYErccyx7ZxbHvSDaeXp2ig5BwSrTf');

// Tree configuration constants
export const DEFAULT_TREE_HEIGHT = 26; // Default Merkle tree height (supports 2^26 = ~67M leaves)
export const DEFAULT_ROOT_HISTORY_SIZE = 100; // Default root history size

dotenv.config();

// Program ID for the zkcash program on devnet
const PROGRAM_ID = new PublicKey('ATZj4jZ4FFzkvAcvk27DW9GRkgSbFnHo49fKKPQXU7VS');

// USDC mint address on devnet
const USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

// Configure connection to Solana devnet
const connection = new Connection('https://domini-i2gp2o-fast-devnet.helius-rpc.com', 'confirmed');

/**
 * Derive Merkle Tree PDA for a mint address
 */
function deriveMerkleTreePDA(mintAddress: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('merkle_tree'), mintAddress.toBuffer()],
    PROGRAM_ID
  );
}

/**
 * Get ALT address from MerkleTreeAccount
 * @param connection Solana connection
 * @param treeAccount The tree account PDA
 * @returns ALT address or null if not set (sentinel value)
 */
async function getALTAddressFromPool(
  connection: Connection,
  treeAccount: PublicKey
): Promise<PublicKey | null> {
  try {
    const accountInfo = await connection.getAccountInfo(treeAccount);
    if (!accountInfo) {
      return null;
    }
    
    // Parse alt_address from account data
    // Layout: discriminator(8) + authority(32) + next_index(8) + subtrees(832) + root(32) + root_history(3200) + root_index(8) + max_deposit_amount(8) + height(1) + root_history_size(1) + bump(1) + alt_address(32)
    // Offset: 8 + 32 + 8 + 832 + 32 + 3200 + 8 + 8 + 1 + 1 + 1 = 4131
    const altAddressBytes = accountInfo.data.slice(4131, 4131 + 32);
    const altAddress = new PublicKey(altAddressBytes);
    
    // Check if it's the sentinel value (all zeros = no ALT set)
    const sentinelBytes = Buffer.alloc(32, 0);
    const sentinel = new PublicKey(sentinelBytes);
    if (altAddress.equals(sentinel)) {
      return null;
    }
    
    return altAddress;
  } catch (error) {
    console.error('Error reading ALT address from pool:', error);
    return null;
  }
}

/**
 * Create an Address Lookup Table (ALT) for a token pool
 * @param connection Solana connection
 * @param payer Keypair that will pay for ALT creation
 * @param mintAddress The SPL token mint address
 * @param treeAccount The tree account PDA
 * @param globalConfig The global config PDA
 * @param relayerAddress The relayer address from global config
 * @returns The ALT address
 */
async function createTokenALT(
  connection: Connection,
  payer: Keypair,
  mintAddress: PublicKey,
  treeAccount: PublicKey,
  globalConfig: PublicKey,
  relayerAddress: PublicKey
): Promise<PublicKey> {
  console.log('📋 Creating Address Lookup Table for token pool...\n');
  
  // Derive token-specific addresses
  const treeAta = getAssociatedTokenAddressSync(mintAddress, globalConfig, true);
  const feeRecipientTokenAccount = getAssociatedTokenAddressSync(mintAddress, FEE_RECIPIENT_ACCOUNT, true);
  const relayerTokenAccount = getAssociatedTokenAddressSync(mintAddress, relayerAddress, false);
  
  // Build list of addresses to include in ALT
  const altAddresses = [
    // Common protocol addresses
    PROGRAM_ID,
    globalConfig,
    FEE_RECIPIENT_ACCOUNT,
    SystemProgram.programId,
    ComputeBudgetProgram.programId,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    
    // Token-specific addresses
    mintAddress,
    treeAccount,
    treeAta,
    feeRecipientTokenAccount,
    relayerAddress,
    relayerTokenAccount,
  ];
  
  console.log(`ALT will contain ${altAddresses.length} addresses:`);
  altAddresses.forEach((addr, i) => {
    console.log(`   ${i + 1}. ${addr.toString()}`);
  });
  console.log();
  
  // Create ALT with retry logic
  let altAddress: PublicKey;
  let maxRetries = 3;
  let retryCount = 0;
  
  while (retryCount < maxRetries) {
    try {
      const recentSlot = await connection.getSlot('processed');
      console.log(`Using recent slot: ${recentSlot}`);
      
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const [lookupTableInst, lookupTableAddr] = AddressLookupTableProgram.createLookupTable({
        authority: payer.publicKey,
        payer: payer.publicKey,
        recentSlot: recentSlot,
      });
      
      altAddress = lookupTableAddr;
      console.log(`New ALT address: ${altAddress.toString()}\n`);
      
      const createALTTx = new Transaction().add(lookupTableInst);
      await sendAndConfirmTransaction(connection, createALTTx, [payer], {
        commitment: 'confirmed',
        skipPreflight: false,
      });
      
      console.log('✅ ALT created successfully\n');
      break;
    } catch (error: any) {
      const isSlotTooOld = error.transactionLogs?.some((log: string) => 
        log.includes('is not a recent slot')
      ) || error.message?.includes('not a recent slot');
      
      if (isSlotTooOld && retryCount < maxRetries - 1) {
        retryCount++;
        console.log(`⚠️  Slot too old, retrying (attempt ${retryCount + 1}/${maxRetries})...\n`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      } else {
        throw error;
      }
    }
  }
  
  // Wait for ALT to be available
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Add addresses to ALT (all fit in one batch since < 30 addresses)
  console.log('Adding addresses to ALT...');
  const extendInstruction = AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey,
    authority: payer.publicKey,
    lookupTable: altAddress!,
    addresses: altAddresses,
  });
  
  const extendTx = new Transaction().add(extendInstruction);
  await sendAndConfirmTransaction(connection, extendTx, [payer], {
    commitment: 'confirmed',
  });
  
  console.log(`✅ Successfully added ${altAddresses.length} addresses to ALT\n`);
  console.log(`ALT Address: ${altAddress!.toString()}\n`);
  
  return altAddress!;
}

/**
 * Example output:
 * Generated PDAs:
 * Tree Account for SPL Token: xxx
 * Global Config: xxx
 * Initialization successful!
 * Transaction signature: xxx
 * Transaction link: https://explorer.solana.com/tx/xxx?cluster=devnet
 */
async function initializeSplTree() {
  try {
    // Load wallet keypair (for paying transaction fees)
    let payer: Keypair;
    
    try {
      const anchorDirPath = path.join(__dirname, '..', 'anchor');
      const deployKeypairPath = path.join(anchorDirPath, 'deploy-keypair.json');
      const keypairJson = JSON.parse(readFileSync(deployKeypairPath, 'utf-8'));
      payer = Keypair.fromSecretKey(Uint8Array.from(keypairJson));
      console.log('Using deploy-keypair.json from anchor directory');
    } catch (err) {
      console.error('Could not load deploy-keypair.json from anchor directory');
      return;
    }

    console.log(`Using wallet: ${payer.publicKey.toString()}`);
    console.log(`Initializing tree for USDC mint: ${USDC_MINT.toString()}`);

    // Check wallet balance
    const balance = await connection.getBalance(payer.publicKey);
    console.log(`Wallet balance: ${balance / 1e9} SOL`);

    if (balance === 0) {
      console.error('Wallet has no SOL. Please fund your wallet before initializing the tree.');
      return;
    }

    // Load IDL
    const idlPath = path.join(__dirname, '..', 'anchor', 'target', 'idl', 'zkcash.json');
    const idl = JSON.parse(readFileSync(idlPath, 'utf-8'));

    // Setup Anchor provider and program
    const wallet = new Wallet(payer);
    const provider = new AnchorProvider(connection, wallet, {
      commitment: 'confirmed',
      preflightCommitment: 'confirmed',
    });
    const program = new Program(idl, provider);
    
    // Derive PDA (Program Derived Addresses) for SPL token tree
    const [treeAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from('merkle_tree'), USDC_MINT.toBuffer()],
      PROGRAM_ID
    );

    const [globalConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from('global_config')],
      PROGRAM_ID
    );

    console.log('\nGenerated PDAs:');
    console.log(`Tree Account for SPL Token: ${treeAccount.toString()}`);
    console.log(`Global Config: ${globalConfig.toString()}`);
    console.log(`USDC Mint: ${USDC_MINT.toString()}`);

    // Check if tree account already exists
    const treeAccountInfo = await connection.getAccountInfo(treeAccount);
    
    if (treeAccountInfo) {
      console.log('\n⚠️  SPL Token tree already initialized on devnet!');
      console.log(`Tree Account exists: ${treeAccount.toString()}`);
      console.log(`View on explorer: https://explorer.solana.com/address/${treeAccount.toString()}?cluster=devnet`);
      return;
    }

    // Check if global config exists (should be initialized first via initialize_devnet.ts)
    const globalConfigInfo = await connection.getAccountInfo(globalConfig);
    if (!globalConfigInfo) {
      console.error('\n❌ Global config not found! Please run initialize_devnet.ts first to initialize the main program.');
      return;
    }

    console.log('\n✓ Global config exists.');
    console.log('✓ Tree account does not exist. Proceeding with initialization...');

    // Get relayer address - use env var or default
    // Note: Original repo doesn't store relayer in GlobalConfig, so we use a default or env var
    const RELAYER_ADDRESS = process.env.RELAYER_ADDRESS || 'AF8VuwCncKd5ZBnLYYnMjqh4vLch8mjqE75sFe5ZjRFW';
    const relayerAddress = new PublicKey(RELAYER_ADDRESS);
    console.log(`Relayer address: ${relayerAddress.toString()}\n`);

    // ===== Create ALT for SPL Pool =====
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    const altAddress = await createTokenALT(
      connection,
      payer,
      USDC_MINT,
      treeAccount,
      globalConfig,
      relayerAddress
    );
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Maximum deposit amount (e.g., 1,000,000 USDC with 6 decimals = 1,000,000,000,000)
    // For devnet, let's set a reasonable limit like 10,000 USDC
    const maxDepositAmount = new BN(100_000_000_000); // 100,000 USDC (6 decimals)

    console.log(`Max deposit amount: ${maxDepositAmount.toString()} (${maxDepositAmount.div(new BN(1_000_000)).toString()} USDC)\n`);

    // ===== Initialize SPL Tree with ALT =====
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📋 Initializing SPL Tree...\n');
    console.log('Sending transaction...');
    
    // Use Anchor to call the instruction with ALT address
    const txSignature = await program.methods
      .initializeTreeAccountForSplToken(maxDepositAmount, altAddress)
      .accounts({
        treeAccount: treeAccount,
        mint: USDC_MINT,
        globalConfig: globalConfig,
        authority: payer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    
    console.log('\n✅ SPL Token tree initialization successful!');
    console.log(`Transaction signature: ${txSignature}`);
    console.log(`Transaction link: https://explorer.solana.com/tx/${txSignature}?cluster=devnet`);
    console.log(`\nTree Account: ${treeAccount.toString()}`);
    console.log(`ALT Address: ${altAddress.toString()}`);
    console.log(`View tree account: https://explorer.solana.com/address/${treeAccount.toString()}?cluster=devnet`);
    console.log(`View ALT: https://explorer.solana.com/address/${altAddress.toString()}?cluster=devnet`);
  } catch (error) {
    console.error('\n❌ Error initializing SPL token tree:', error);
    if (error instanceof Error) {
      console.error('Error message:', error.message);
      if ('logs' in error) {
        console.error('Program logs:', (error as any).logs);
      }
    }
  }
}

// Run the initialize function
initializeSplTree();

