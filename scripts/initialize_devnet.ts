import { Connection, Keypair, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction, TransactionInstruction, SendTransactionError } from '@solana/web3.js';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import BN from 'bn.js';

export const FIELD_SIZE = new BN('21888242871839275222246405745257275088548364400416034343698204186575808495617')

// Fee recipient account for all transactions
export const FEE_RECIPIENT_ACCOUNT = new PublicKey('DTqtRSGtGf414yvMPypCv2o1P8trwb9SJXibxLgAWYhw');

// Fee rates in basis points (1 basis point = 0.01%, 10000 = 100%)
export const DEPOSIT_FEE_RATE = 0; // 0% - Free deposits
export const WITHDRAW_FEE_RATE = 25; // 0.25% - Fee on withdrawals
export const FEE_ERROR_MARGIN = 500; // 5% tolerance (minimum fee = 95% of expected)

// Tree configuration constants
export const DEFAULT_TREE_HEIGHT = 26; // Default Merkle tree height (supports 2^26 = ~67M leaves)
export const DEFAULT_ROOT_HISTORY_SIZE = 100; // Default root history size

// Import the IDL directly from anchor directory
const idlPath = path.join(__dirname, '..', 'anchor', 'target', 'idl', 'zkcash.json');
const idl = JSON.parse(readFileSync(idlPath, 'utf-8'));

dotenv.config();

// Program ID for the zkcash program on devnet
const PROGRAM_ID = new PublicKey('ATZj4jZ4FFzkvAcvk27DW9GRkgSbFnHo49fKKPQXU7VS');

// Configure connection to Solana mainnet-beta
const connection = new Connection('https://domini-i2gp2o-fast-devnet.helius-rpc.com', 'confirmed');

// Anchor program initialize instruction discriminator
// This is the first 8 bytes of the SHA256 hash of "global:initialize" 
const INITIALIZE_IX_DISCRIMINATOR = Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]);

/**
 * Example output:
 * Generated PDAs:
 * Tree Account: 2R6iQwfvX2ixi21MFnm3KSDBfFrCAWv7qpw2cE9ygqt5
 * Tree Token Account: FwQAFcHJqDWNBLKoa5qncZhP8fceV2E46HtBWzW4KRFn
 * Initialization successful!
 * Transaction signature: 3h95C7aZNeowpZhsBXFbYkjYaKGEhpDqcaTBzzTiXxwPNUCNJhgxntVpwtjMK5NBqwZk3kaE4D9nkFyANTbKbNiP
 * Transaction link: https://explorer.solana.com/tx/3h95C7aZNeowpZhsBXFbYkjYaKGEhpDqcaTBzzTiXxwPNUCNJhgxntVpwtjMK5NBqwZk3kaE4D9nkFyANTbKbNiP?cluster=devnet
 */
async function initialize() {
  try {
    // Load wallet keypair (for paying transaction fees, NOT the program keypair)
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

    // Check wallet balance
    const balance = await connection.getBalance(payer.publicKey);
    console.log(`Wallet balance: ${balance / 1e9} SOL`);

    if (balance === 0) {
      console.error('Wallet has no SOL. Please fund your wallet before initializing the program.');
      return;
    }
    
    // Derive PDA (Program Derived Addresses)
    const [treeAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from('merkle_tree')],
      PROGRAM_ID
    );

    const [treeTokenAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from('tree_token')],
      PROGRAM_ID
    );

    const [globalConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from('global_config')],
      PROGRAM_ID
    );

    console.log('Generated PDAs:');
    console.log(`Tree Account: ${treeAccount.toString()}`);
    console.log(`Tree Token Account: ${treeTokenAccount.toString()}`);
    console.log(`Global Config: ${globalConfig.toString()}`);

    // Check if accounts already exist
    const treeAccountInfo = await connection.getAccountInfo(treeAccount);
    const globalConfigInfo = await connection.getAccountInfo(globalConfig);
    
    if (treeAccountInfo || globalConfigInfo) {
      console.log('\n⚠️  Program already initialized on devnet!');
      console.log('Accounts already exist:');
      if (treeAccountInfo) console.log(`  ✓ Tree Account: ${treeAccount.toString()}`);
      if (globalConfigInfo) console.log(`  ✓ Global Config: ${globalConfig.toString()}`);
      console.log('\nIf you need to reinitialize, you must first close these accounts or use a different program ID.');
      console.log(`View on explorer: https://explorer.solana.com/address/${treeAccount.toString()}?cluster=devnet`);
      return;
    }

    console.log('\n✓ Accounts do not exist. Proceeding with initialization...');

    // Create instruction data - only discriminator (initialize takes no parameters)
    const data = INITIALIZE_IX_DISCRIMINATOR;

    // Create the instruction
    const initializeIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: treeAccount, isSigner: false, isWritable: true },
        { pubkey: treeTokenAccount, isSigner: false, isWritable: true },
        { pubkey: globalConfig, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    // Create and send transaction
    const transaction = new Transaction().add(initializeIx);
    
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    transaction.feePayer = payer.publicKey;
    
    const txSignature = await sendAndConfirmTransaction(connection, transaction, [payer]);
    
    console.log('Initialization successful!');
    console.log(`Transaction signature: ${txSignature}`);
    console.log(`Transaction link: https://explorer.solana.com/tx/${txSignature}`);
  } catch (error) {
    console.error('Error initializing program:', error);
  }
}

// Run the initialize function
initialize();