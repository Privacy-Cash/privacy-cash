import { Connection, PublicKey } from '@solana/web3.js';
import * as dotenv from 'dotenv';

dotenv.config();

// Program ID for the zkcash program
const PROGRAM_ID = new PublicKey('6JFJ27mebUcPSw1X5z5X6yKePQmuwQkusS7xNpE9kuUr');

// Configure connection to Solana devnet
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

// Hardcoded deployer/authority public key
const DEPLOYER = new PublicKey('FrhAUwGkoVD6TC8xGnYp5g5nNkuZiG7sXCyofZEuQ7hC');

async function checkFeesBalance() {
  try {
    console.log('=== ZKCash Fees Balance Checker ===\n');
    
    // Find the fee recipient PDA
    const [feeRecipientAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from('fee_recipient'), DEPLOYER.toBuffer()],
      PROGRAM_ID
    );

    console.log(`Deployer/Authority: ${DEPLOYER.toString()}`);
    console.log(`Program ID: ${PROGRAM_ID.toString()}`);
    console.log(`Fee Recipient PDA: ${feeRecipientAccount.toString()}\n`);

    // Get the balance of the fee recipient account
    const balanceLamports = await connection.getBalance(feeRecipientAccount);
    const balanceSOL = balanceLamports / 1e9;

    console.log('=== Fee Recipient Account Balance ===');
    console.log(`Balance: ${balanceLamports.toLocaleString()} lamports`);
    console.log(`Balance: ${balanceSOL.toFixed(9)} SOL\n`);

    // Check if the account exists and has been initialized
    const accountInfo = await connection.getAccountInfo(feeRecipientAccount);
    if (accountInfo) {
      console.log('Account Status: ✓ Initialized');
      console.log(`Account Owner: ${accountInfo.owner.toString()}`);
      console.log(`Account Data Size: ${accountInfo.data.length} bytes`);
      console.log(`Rent Exempt: ${accountInfo.executable ? 'Yes' : 'No'}`);
    } else {
      console.log('Account Status: ✗ Not initialized');
      console.log('Note: The fee recipient account has not been created yet.');
      console.log('Run the initialize script first to create the program accounts.');
    }

    // Also check the tree token account balance for context
    const [treeTokenAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from('tree_token'), DEPLOYER.toBuffer()],
      PROGRAM_ID
    );

    const treeTokenBalanceLamports = await connection.getBalance(treeTokenAccount);
    const treeTokenBalanceSOL = treeTokenBalanceLamports / 1e9;

    console.log('\n=== Tree Token Account Balance (for context) ===');
    console.log(`Tree Token PDA: ${treeTokenAccount.toString()}`);
    console.log(`Balance: ${treeTokenBalanceLamports.toLocaleString()} lamports`);
    console.log(`Balance: ${treeTokenBalanceSOL.toFixed(9)} SOL`);

    const treeTokenAccountInfo = await connection.getAccountInfo(treeTokenAccount);
    if (treeTokenAccountInfo) {
      console.log('Tree Token Account Status: ✓ Initialized');
    } else {
      console.log('Tree Token Account Status: ✗ Not initialized');
    }

    console.log('\n=== Summary ===');
    if (balanceLamports > 0) {
      console.log(`💰 Accumulated fees: ${balanceSOL.toFixed(9)} SOL`);
      console.log('Fees are ready to be withdrawn by the authority.');
    } else {
      console.log('💸 No fees have been accumulated yet.');
      console.log('Fees will accumulate as users perform transactions with the protocol.');
    }

  } catch (error: any) {
    console.error('Error checking fees balance:', error);
    
    if (error.message?.includes('blockhash')) {
      console.error('\nThis might be a network connectivity issue. Please try again.');
    } else if (error.message?.includes('Invalid public key')) {
      console.error('\nInvalid public key format. Please check the program ID or deployer address.');
    }
  }
}

// Export the function for potential reuse
export { checkFeesBalance };

// Run the function if this script is executed directly
if (require.main === module) {
  checkFeesBalance();
} 