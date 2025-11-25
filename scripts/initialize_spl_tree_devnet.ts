import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { AnchorProvider, Program, Wallet } from '@coral-xyz/anchor';
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

    // Maximum deposit amount (e.g., 1,000,000 USDC with 6 decimals = 1,000,000,000,000)
    // For devnet, let's set a reasonable limit like 10,000 USDC
    const maxDepositAmount = new BN(100_000_000_000); // 100,000 USDC (6 decimals)

    console.log(`\nMax deposit amount: ${maxDepositAmount.toString()} (${maxDepositAmount.div(new BN(1_000_000)).toString()} USDC)`);

    console.log('\nSending transaction...');
    
    // Use Anchor to call the instruction
    const txSignature = await program.methods
      .initializeTreeAccountForSplToken(maxDepositAmount)
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
    console.log(`View tree account: https://explorer.solana.com/address/${treeAccount.toString()}?cluster=devnet`);
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

