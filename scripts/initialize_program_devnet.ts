import { Connection, Keypair, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction, TransactionInstruction, SendTransactionError } from '@solana/web3.js';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Import the IDL directly from anchor directory
const idlPath = path.join(__dirname, '..', 'anchor', 'target', 'idl', 'zkcash.json');
const idl = JSON.parse(readFileSync(idlPath, 'utf-8'));

dotenv.config();

// Program ID for the zkcash program
const PROGRAM_ID = new PublicKey('AW7zH2XvbZZuXtF7tcfCRzuny7L89GGqB3z3deGpejWQ');

// Configure connection to Solana devnet
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

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
    // Load wallet keypair from deploy-keypair.json in anchor directory
    let payer: Keypair;
    
    try {
      // Try to load from deploy-keypair.json in anchor directory
      const anchorDirPath = path.join(__dirname, '..', 'anchor');
      const deployKeypairPath = path.join(anchorDirPath, 'deploy-keypair.json');
      const keypairJson = JSON.parse(readFileSync(deployKeypairPath, 'utf-8'));
      payer = Keypair.fromSecretKey(Uint8Array.from(keypairJson));
      console.log('Using deploy keypair from anchor directory');
    } catch (err) {
      console.log('Could not load deploy-keypair.json from anchor directory');
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
      [Buffer.from('merkle_tree'), payer.publicKey.toBuffer()],
      PROGRAM_ID
    );

    const [treeTokenAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from('tree_token'), payer.publicKey.toBuffer()],
      PROGRAM_ID
    );

    console.log('Generated PDAs:');
    console.log(`Tree Account: ${treeAccount.toString()}`);
    console.log(`Tree Token Account: ${treeTokenAccount.toString()}`);

    // Create instruction data - just the discriminator for initialize
    const data = INITIALIZE_IX_DISCRIMINATOR;

    // Create the instruction
    const initializeIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: treeAccount, isSigner: false, isWritable: true },
        { pubkey: treeTokenAccount, isSigner: false, isWritable: true },
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
    console.log(`Transaction link: https://explorer.solana.com/tx/${txSignature}?cluster=devnet`);
  } catch (error) {
    console.error('Error initializing program:', error);
  }
}

// Run the initialize function
initialize();